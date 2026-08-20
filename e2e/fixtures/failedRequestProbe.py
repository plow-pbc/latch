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
    def __init__(self, method):
        self.method = method


class Response:
    """One response the page received.

    `body()` raises rather than returning anything: a body can echo a submitted
    credential, so the listener must never reach for one, and a stub that
    quietly answered would let that regress unnoticed.
    """

    def __init__(self, status, url, method="GET", headers=None):
        self.status = status
        self.url = url
        self.request = Request(method)
        self.headers = headers or {}

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
        self.context = Context()
        self.context.pages.append(self)

    def evaluate(self, expression, *args, **kwargs):
        return "doc-1"


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
    out["refused"] = session.envelope({"ok": True}, "click")

    # Drained exactly once: the next action does not re-report it.
    out["drained"] = session.envelope({"ok": True}, "screenshot")

    # The owner's viewer polls ~1/s while a session is live, and nothing reads a
    # refusal off a viewer frame. If that drained, the viewer being open would
    # eat almost every refusal before the agent's next action saw it.
    session = server.Session(Page())
    feed(session, [Response(403, "https://pizza.example/api/cart")])
    out["viewer_poll"] = session.envelope({"data_b64": "x"}, "view")
    out["after_viewer_poll"] = session.envelope({"ok": True}, "click")

    # A page that works keeps nothing, redirects included — a login flow is
    # mostly 3xx and they would push the one refusal out of the ring.
    session = server.Session(Page())
    feed(session, [Response(200, "https://pizza.example/a"), Response(204, "https://pizza.example/b"),
                   Response(302, "https://pizza.example/c"), Response(304, "https://pizza.example/d")])
    out["quiet"] = session.envelope({"ok": True}, "click")

    # Bounded, most recent first: a chatty page cannot blow the exchange budget.
    session = server.Session(Page())
    feed(session, [Response(403, "https://pizza.example/x%d" % i) for i in range(9)])
    out["bounded"] = session.envelope({"ok": True}, "click")

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
    out["hostile"] = session.envelope({"ok": True}, "click")

    real_stdout.write(json.dumps(out) + "\n")
    real_stdout.flush()


if __name__ == "__main__":
    main()
