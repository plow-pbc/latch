#!/usr/bin/env python3
"""Run the REAL response listener in server.py against stub Playwright objects.

What it answers: which responses `Session.note_response` keeps, what it keeps
about them, and that `envelope` hands each one to the client exactly once.
Nothing but the actual Python can answer that, so this drives it directly.

Like fillProbe.py this is optional: `failedRequests.test.ts` skips it when
python3 is missing, and Camoufox/Playwright are never imported — `main()` is not
called, and the browser only enters the picture there.

Usage: failedRequestProbe.py
Prints {"<scenario>": {...}} on stdout. A response body is never read here —
the stub raises if anything asks for one, which is the point of one scenario.

Importing server.py claims the process's stdout for its own protocol channel and
points fd 1 at stderr, so this keeps a duplicate of the real stdout from before
that happens and reports on it.
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


class Request:
    def __init__(self, method, navigation=False, url="", redirected_from=None):
        self.method = method
        self.url = url
        self.redirected_from = redirected_from
        self._navigation = navigation

    def is_navigation_request(self):
        return self._navigation


class Frame:
    def __init__(self, url, parent_frame=None):
        self.url = url
        self.parent_frame = parent_frame


class Response:
    """One response the page received.

    `body()` raises rather than returning anything: a body can echo a submitted
    credential, so the listener must never reach for one, and a stub that
    quietly answered would let that regress unnoticed.
    """

    def __init__(self, status, url, method="GET", headers=None,
                 page="https://pizza.example/checkout", navigation=False, embedder=None,
                 frame=None, redirected_from=None):
        self.status = status
        self.url = url
        self.request = Request(method, navigation, url, redirected_from)
        self.headers = headers or {}
        # `frame` names an existing document (the active page's main frame, say);
        # otherwise one is made up from `page`/`embedder`.
        self.frame = frame or Frame(page, None if embedder is None else Frame(embedder))

    def body(self):
        raise AssertionError("the listener read a response body")

    def text(self):
        raise AssertionError("the listener read a response body")


class Context:
    """A browser context that records what was subscribed to it."""

    def __init__(self):
        self.pages = []
        self.listeners = []

    def on(self, event, handler):
        self.listeners.append(event)


class Page:
    def __init__(self):
        self.url = "https://pizza.example/checkout"
        self.main_frame = Frame(self.url)
        self.went_to = None
        self.context = Context()
        self.context.pages.append(self)

    def evaluate(self, expression, *args, **kwargs):
        return "doc-1"

    def wait_for_timeout(self, _ms):
        pass

    def goto(self, url, **_kw):
        """One scenario drives the REAL command handler through here, so the
        line that records what the agent asked for is exercised rather than
        assigned by hand."""
        self.went_to = url

    def title(self):
        return "checkout"

    def bring_to_front(self):
        pass


def feed(session, responses):
    for r in responses:
        session.note_response(r)


def main():
    real_stdout = os.fdopen(os.dup(1), "w")
    server = load_server()
    out = {}

    # Registered at construction, on the CONTEXT: a popup's responses are the
    # ones an agent is most likely to be blind to, and a page-level listener
    # would miss every one of them.
    session = server.Session(Page())
    out["listens"] = session.page.context.listeners

    # A refused XHR is kept, with the query gone and the diagnostic headers on.
    feed(session, [Response(429, "https://signin.example/tenant/SelfAsserted?tx=StateProperties=SECRET&p=B2C_1",
                            "POST", {"content-length": "1180", "retry-after": "30", "server": "cloudfront"})])
    out["refused"] = session.envelope({"ok": True})

    # Drained exactly once: the next action does not re-report it.
    out["drained"] = session.envelope({"ok": True})

    # A page that works keeps nothing, redirects included — a login flow is
    # mostly 3xx and they would push the one refusal out of the ring.
    session = server.Session(Page())
    feed(session, [Response(200, "https://pizza.example/a"), Response(204, "https://pizza.example/b"),
                   Response(302, "https://pizza.example/c"), Response(304, "https://pizza.example/d")])
    out["quiet"] = session.envelope({"ok": True})

    # Bounded, most recent first: a chatty page cannot blow the exchange budget.
    session = server.Session(Page())
    feed(session, [Response(403, "https://pizza.example/x%d" % i) for i in range(9)])
    out["bounded"] = session.envelope({"ok": True})

    # The goto the agent asked for IS its own document: when the headers arrive
    # the frame still names the page being left, and attributing a refused goto
    # to that page would withhold it from the agent that asked for the new one.
    # The frame's url stays stale here on purpose — only self-attribution can
    # produce the answer this asserts.
    # Driven through the real command handler, query and all: the goto records
    # what was asked for, stripped, and the refusal that answers it is the
    # agent's own.
    session = server.Session(Page())
    session.handle({"action": "goto", "url": "https://pizza.example/checkout?tx=SECRET"}, "/tmp")
    session.page.main_frame.url = "https://pizza.example/cart"
    feed(session, [Response(429, "https://pizza.example/checkout", navigation=True,
                            frame=session.page.main_frame)])
    out["navigation"] = session.envelope({"ok": True})
    out["navigation_asked_for"] = session.page.went_to

    # Through a redirect: the site answered the requested url with a 302 and
    # then refused. The agent still asked for it.
    session = server.Session(Page())
    session.goto_url = "https://pizza.example/signin"
    session.page.main_frame.url = "https://pizza.example/cart"
    feed(session, [Response(429, "https://signin.pizza.example/b2c", navigation=True,
                            frame=session.page.main_frame,
                            redirected_from=Request("GET", True, "https://pizza.example/signin"))])
    out["redirected_navigation"] = session.envelope({"ok": True})

    # The page navigating ITSELF is not the agent asking. An unapproved page
    # scripting location = "<approved host>/<text of its choosing>" would
    # otherwise write the agent's evidence.
    session = server.Session(Page())
    session.goto_url = "https://pizza.example/cart"
    session.page.main_frame.url = "https://offsite.example/lander"
    feed(session, [Response(404, "https://pizza.example/anything-it-likes", navigation=True,
                            frame=session.page.main_frame)])
    out["self_navigation"] = session.envelope({"ok": True})

    # A chain longer than the browser's own ceiling gives up rather than
    # walking forever, and gives up on the safe side.
    session = server.Session(Page())
    session.goto_url = "https://pizza.example/start"
    session.page.main_frame.url = "https://pizza.example/cart"
    root = server_request = Request("GET", True, "https://pizza.example/start")
    for hop in range(server.MAX_REDIRECT_HOPS + 1):
        server_request = Request("GET", True, "https://pizza.example/hop%d" % hop, server_request)
    feed(session, [Response(429, "https://pizza.example/end", navigation=True,
                            frame=session.page.main_frame,
                            redirected_from=server_request)])
    out["over_the_hop_limit"] = session.envelope({"ok": True})
    assert root is not None

    # use_page moves the active page, and the check follows it: a goto in the
    # popup the agent switched to is the agent's, one in the page it left is
    # not, and the pointer does not survive the switch.
    session = server.Session(Page())
    popup = Page()
    popup.main_frame.url = "https://pizza.example/opened"
    left = session.page
    session.page = popup
    session.goto_url = "https://pizza.example/pay"
    feed(session, [Response(429, "https://pizza.example/pay", navigation=True,
                            frame=popup.main_frame)])
    out["after_use_page"] = session.envelope({"ok": True})
    feed(session, [Response(429, "https://pizza.example/pay", navigation=True,
                            frame=left.main_frame)])
    out["page_left_behind"] = session.envelope({"ok": True})

    # Switching pages clears what the previous page was sent to, so the page
    # switched to cannot name itself by navigating there.
    session = server.Session(Page())
    popup = Page()
    popup.main_frame.url = "https://offsite.example/lander"
    session.page.context.pages.append(popup)
    session.goto_url = "https://pizza.example/pay"
    session.handle({"action": "use_page", "index": 1}, "/tmp")
    feed(session, [Response(429, "https://pizza.example/pay", navigation=True,
                            frame=popup.main_frame)])
    out["stale_pointer"] = session.envelope({"ok": True})

    # A navigation in a frame the agent is NOT driving -- a popup opened in the
    # background and then pointed somewhere -- is named by the document it is
    # showing, never by the url somebody else chose for it.
    session = server.Session(Page())
    feed(session, [Response(404, "https://pizza.example/anything-it-likes", navigation=True,
                            page="https://offsite.example/lander")])
    out["background_navigation"] = session.envelope({"ok": True})

    # A SUBframe navigation belongs to whoever embedded it. Crediting it to
    # itself would let an unapproved page point an iframe at an approved host
    # and have the url it chose handed to the agent.
    session = server.Session(Page())
    feed(session, [Response(403, "https://pizza.example/anything-it-likes", navigation=True,
                            embedder="https://offsite.example/lander")])
    out["subframe_navigation"] = session.envelope({"ok": True})

    # A frame that will not answer -- a service worker's request, or a popup's
    # opening navigation before its frame exists. The entry is still kept, with
    # nothing claimed about who asked.
    class NoFrame(Response):
        @property
        def frame(self):
            raise RuntimeError("no frame for this request")

        @frame.setter
        def frame(self, _v):
            pass

    session = server.Session(Page())
    feed(session, [NoFrame(403, "https://pizza.example/api/sw")])
    out["unattributable"] = session.envelope({"ok": True})

    # A popup's opening navigation is the same answer and deliberately so:
    # window.open from a page outside the approved origins is the iframe smuggle
    # by another door, so an unresolvable frame names nothing even here.
    session = server.Session(Page())
    feed(session, [NoFrame(403, "https://pizza.example/popup", navigation=True)])
    out["unattributable_navigation"] = session.envelope({"ok": True})

    # A response that will not answer its own questions takes nothing down.
    class Hostile(Response):
        @property
        def headers(self):
            raise RuntimeError("detached")

        @headers.setter
        def headers(self, _v):
            pass

    session = server.Session(Page())
    feed(session, [Hostile(429, "https://pizza.example/boom"), Response(401, "https://pizza.example/ok")])
    out["hostile"] = session.envelope({"ok": True})

    real_stdout.write(json.dumps(out) + "\n")
    real_stdout.flush()


if __name__ == "__main__":
    main()
