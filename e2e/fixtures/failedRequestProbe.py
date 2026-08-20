#!/usr/bin/env python3
"""Run the REAL response listener in server.py against stub Playwright objects.

Which responses `Session.note_response` keeps, what it keeps about them, and
that every reply carries them exactly once — only the actual Python can answer
that. Like fillProbe.py (whose conventions this follows, including keeping a
duplicate of the real stdout before importing server.py claims it) this is
optional: `failedRequests.test.ts` skips it where there is no python3, and
Camoufox is never imported because `main()` is never called.

Prints {"<scenario>": {...}} on stdout. A body is never read here — the stub
raises if anything asks for one, which is the point of one scenario.
"""
import importlib.util
import json
import os
import sys


def load_server():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "..", "..", "vendor", "browser-server", "server.py")
    spec = importlib.util.spec_from_file_location("domo_browser_server", path)
    module = importlib.util.module_from_spec(spec)
    sys.argv = ["server.py", "--screenshots-dir", "/tmp"]
    spec.loader.exec_module(module)
    return module


class Response:
    """One response the page received.

    `body()` raises rather than returning anything: a body can echo a submitted
    credential, so the listener must never reach for one, and a stub that
    quietly answered would let that regress unnoticed.
    """

    def __init__(self, status, url, method="GET", headers=None, page="", navigation=False,
                 frame=None):
        self.status = status
        self.url = url
        self.request = type("Request", (), {"method": method,
                                            "is_navigation_request": lambda _s=None: navigation})()
        self.headers = headers or {}
        # `frame` is the object identity the server compares against the active
        # page's main frame; `page` is the url that frame is showing.
        self.frame = frame if frame is not None else type("Frame", (), {"url": page})()

    def body(self):
        raise AssertionError("the listener read a response body")

    text = body


class Context:
    """A browser context that records what was subscribed to it."""

    def __init__(self):
        self.pages = []
        self.listeners = []

    def on(self, event, _handler):
        self.listeners.append(event)


class Page:
    """The active page, recording whether the device's navigation flag was up
    while each navigation ran — that flag is what a security gate reads."""

    def __init__(self, session=None):
        self.url = "https://pizza.example/checkout"
        self.main_frame = object()
        self.context = Context()
        self.context.pages.append(self)
        self.session = session
        self.flag_during = {}
        self.flag_after = {}
        # A response the page receives while a navigation is in flight, which is
        # when a real one arrives: headers first, before the call returns.
        self.during_navigation = None

    def _navigate(self, action):
        self.flag_during[action] = self.session.in_device_nav
        if self.during_navigation is not None:
            hook, self.during_navigation = self.during_navigation, None
            hook()

    def goto(self, _url, **_kw):
        self._navigate("goto")

    def go_back(self, **_kw):
        self._navigate("back")

    def wait_for_timeout(self, _ms):
        pass

    def title(self):
        return "checkout"

    def evaluate(self, *_a, **_kw):
        return "doc-1"


def feed(session, responses):
    for r in responses:
        session.note_response(r)
    return session.reply_with_failures({})


def main():
    real_stdout = os.fdopen(os.dup(1), "w")
    server = load_server()
    out = {}

    # Registered at construction, on the CONTEXT: a popup's responses are the
    # ones an agent is most likely to be blind to, and a page-level listener
    # would miss every one of them.
    session = server.Session(Page())
    out["listens"] = session.page.context.listeners

    # A refused request keeps its origin and nothing else — not the path, which
    # a site can put a token in as readily as a query.
    out["refused"] = feed(session, [Response(
        429, "https://user:pw@signin.example/reset/TOKEN?tx=StateProperties=SECRET",
        "POST", {"retry-after": "30", "server": "cloudfront"},
        page="https://pizza.example/checkout")])

    # Who asked, at origin granularity. Only a navigation the DEVICE issued
    # answers for itself — a page pointing ITSELF at an approved host is named
    # by the document it is still showing, or it could pass its own trouble off
    # as that host's.
    session = server.Session(Page())
    main = type("Frame", (), {"url": "https://offsite.example/lander"})()
    session.page.main_frame = main
    out["page_navigating_itself"] = feed(session, [
        Response(403, "https://pizza.example/api/x", page="https://offsite.example/lander"),
        Response(429, "https://pizza.example/checkout", navigation=True, frame=main),
    ])
    # Driven through the real handler: the flag is up while the navigation runs
    # and down after, for `goto` and for `back` alike.
    driven = server.Session(Page())
    driven.page.session = driven
    driven.page.main_frame = main
    # The refusal arrives DURING the goto, as a real one does, so nothing about
    # the flag is set by hand.
    driven.page.during_navigation = lambda: driven.note_response(
        Response(429, "https://pizza.example/checkout", navigation=True, frame=main))
    driven.handle({"action": "goto", "url": "https://pizza.example/checkout"}, "/tmp")
    driven.page.flag_after["goto"] = driven.in_device_nav
    out["device_goto"] = driven.reply_with_failures({})
    driven.handle({"action": "back"}, "/tmp")
    driven.page.flag_after["back"] = driven.in_device_nav
    out["flag_during"] = driven.page.flag_during
    out["flag_after"] = driven.page.flag_after

    # A frame that will not answer names nobody, and the device withholds those
    # from the agent rather than guessing.
    class NoFrame(Response):
        @property
        def frame(self):
            raise RuntimeError("no frame for this request")

        @frame.setter
        def frame(self, _v):
            pass

    session = server.Session(Page())
    out["unattributable"] = feed(session, [NoFrame(403, "https://pizza.example/api/sw")])

    # Handed over once: the next reply is not told again.
    out["drained"] = session.reply_with_failures({})

    # A page that works keeps nothing, redirects included — a sign-in flow is
    # mostly 3xx and they would push the one refusal out of a short ring.
    session = server.Session(Page())
    out["quiet"] = feed(session, [Response(200, "https://pizza.example/a"),
                                  Response(302, "https://pizza.example/b"),
                                  Response(304, "https://pizza.example/c")])

    # Bounded, most recent first: a chatty page cannot blow the exchange budget.
    session = server.Session(Page())
    out["bounded"] = feed(session, [
        Response(403, "https://pizza.example/x%d" % i) for i in range(9)])

    real_stdout.write(json.dumps(out) + "\n")
    real_stdout.flush()


if __name__ == "__main__":
    main()
