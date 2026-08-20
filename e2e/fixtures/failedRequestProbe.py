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


class Request:
    """One request, and the document that made it — whose url the server reads
    when the REQUEST is made, never when the response comes back.

    Subclassed rather than mutated where a scenario needs the frame to raise, so
    one scenario cannot change what the others see.
    """

    def __init__(self, method, page, navigation=False, embedder=None):
        self.method = method
        parent = None if embedder is None else type("Frame", (), {"url": embedder})()
        self.frame = type("Frame", (), {"url": page, "parent_frame": parent})()
        self._navigation = navigation

    def is_navigation_request(self):
        return self._navigation


class BlindRequest(Request):
    """A request Playwright will not name a frame for."""

    def __init__(self, method="GET", navigation=False):
        self.method = method
        self._navigation = navigation

    @property
    def frame(self):
        raise RuntimeError("no frame for this request")


class Response:
    """One response the page received.

    `body()` raises rather than returning anything: a body can echo a submitted
    credential, so the listener must never reach for one, and a stub that
    quietly answered would let that regress unnoticed.
    """

    def __init__(self, status, url, method="GET", headers=None, page="", navigation=False,
                 embedder=None):
        self.status = status
        self.url = url
        # One request object per response, since the server remembers who asked
        # by the request itself.
        self.request = Request(method, page, navigation, embedder)
        self.headers = headers or {}

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
    def __init__(self):
        self.url = "https://pizza.example/checkout"
        self.context = Context()
        self.context.pages.append(self)
    def wait_for_timeout(self, _ms):
        pass

    def title(self):
        return "checkout"

    def evaluate(self, *_a, **_kw):
        return "doc-1"


def feed(session, responses):
    """Each response as it really happens: the request first, the answer after."""
    for r in responses:
        session.note_request(r.request)
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

    # A TOP-LEVEL navigation is not this feature's business: an agent that goes
    # somewhere and is refused SEES that, on the very next screenshot. A FRAME's
    # document load is invisible in exactly the way this exists for — a payment
    # or sign-in iframe that will not load — and is named by whoever embedded
    # it, since the frame itself is still blank when it asks.
    session = server.Session(Page())
    out["navigations"] = feed(session, [
        Response(429, "https://pizza.example/checkout", navigation=True,
                 page="https://offsite.example/lander"),
        Response(403, "https://payframe.example/pay", navigation=True, page="about:blank",
                 embedder="https://pizza.example/checkout"),
        # A child frame that has ALREADY loaded and navigates itself is named by
        # its own document, not its parent's — otherwise an out-of-scope frame
        # borrows an approved parent's name by moving.
        Response(410, "https://pizza.example/api/z", navigation=True,
                 page="https://offsite.example/embed",
                 embedder="https://pizza.example/checkout"),
        Response(404, "https://pizza.example/api/x", page="https://offsite.example/lander"),
    ])

    # Who asked is read when the request is MADE. A page that asks for something
    # it knows will fail, then moves itself to an approved origin before the
    # answer arrives, would otherwise have the refusal read as that origin's.
    session = server.Session(Page())
    moving = Response(429, "https://pizza.example/api/x", page="https://offsite.example/lander")
    session.note_request(moving.request)
    moving.request.frame.url = "https://pizza.example/checkout"
    session.note_response(moving)
    out["frame_moved_first"] = session.reply_with_failures({})

    # A navigation whose frame will not answer is kept, not lost: the request
    # path decides, and it treats an unanswerable frame as naming nobody rather
    # than as the top frame.
    session = server.Session(Page())
    blind = Response(403, "https://pizza.example/frame", navigation=True, page="about:blank")
    # The frame itself is what will not answer — Playwright raises for a request
    # with none — so nothing can say whether this was the top frame.
    blind.request = BlindRequest(navigation=True)
    session.note_request(blind.request)
    session.note_response(blind)
    out["blind_navigation"] = session.reply_with_failures({})

    # A request that came back fine is forgotten there and then, so completed
    # traffic cannot crowd a still-pending refusal out of the ledger.
    session = server.Session(Page())
    fine = Response(200, "https://pizza.example/ok", page="https://pizza.example/")
    session.note_request(fine.request)
    session.note_response(fine)
    out["forgets_the_answered"] = len(session.asked_by)

    # A request nobody remembers asking for names nobody.
    session = server.Session(Page())
    forgotten = Response(403, "https://pizza.example/api/y", page="https://pizza.example/")
    session.note_response(forgotten)
    out["unremembered"] = session.reply_with_failures({})

    # A frame that will not answer names nobody, and the device withholds those
    # from the agent rather than guessing.
    class NoFrame(Response):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            self.request = BlindRequest()

    # A response that will not answer about its headers is dropped whole: the
    # listener runs on the page's event thread, where the only safe answer to a
    # question that raises is to leave the ring alone.
    class Hostile(Response):
        @property
        def headers(self):
            raise RuntimeError("detached")

        @headers.setter
        def headers(self, _v):
            pass

    session = server.Session(Page())
    out["hostile"] = feed(session, [Hostile(429, "https://pizza.example/boom"),
                                    Response(401, "https://pizza.example/ok")])

    session = server.Session(Page())
    out["unattributable"] = feed(session, [
        NoFrame(403, "https://pizza.example/api/sw"),
        # A frame with no origin of its own is the cheaper version of the same
        # thing: the frame answers, but with a url that names nobody. blob: is
        # the row worth having — it textually embeds an origin, so a looser
        # reading of the url would start naming a document nobody is
        # accountable for.
        Response(429, "https://pizza.example/api/x", page="about:blank"),
        Response(410, "https://pizza.example/api/y", page="blob:https://pizza.example/8f2c"),
    ])

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
        Response(400 + i, "https://pizza.example/x%d" % i, page="https://pizza.example/")
        for i in range(9)])

    real_stdout.write(json.dumps(out) + "\n")
    real_stdout.flush()


if __name__ == "__main__":
    main()
