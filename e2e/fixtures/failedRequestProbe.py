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

    def __init__(self, status, url, method="GET", headers=None, page="", navigation=False):
        self.status = status
        self.url = url
        self.request = type("Request", (), {"method": method,
                                            "is_navigation_request": lambda _s=None: navigation})()
        self.headers = headers or {}
        self.frame = type("Frame", (), {"url": page})()

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

    # Who asked, at origin granularity: a navigation answers for itself, since
    # its frame still names the page being left.
    session = server.Session(Page())
    out["initiators"] = feed(session, [
        Response(403, "https://pizza.example/api/x", page="https://offsite.example/lander"),
        Response(429, "https://pizza.example/checkout", navigation=True,
                 page="https://offsite.example/lander"),
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
        Response(403, "https://pizza.example/x%d" % i) for i in range(9)])

    real_stdout.write(json.dumps(out) + "\n")
    real_stdout.flush()


if __name__ == "__main__":
    main()
