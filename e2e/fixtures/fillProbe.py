#!/usr/bin/env python3
"""Run the REAL fill branch of server.py against stub Playwright objects.

The question this answers is not "does the mark work" — that is the MASK_JS
literal, which vitest runs directly — but "does the mark land on the same node
the value does". Nothing but the actual Python can answer it, so this drives
`Session.handle` and reports which Playwright calls it made, in order.

Like classifyProbe.py this is optional: `fillSecretMasking.test.ts` skips it when
python3 is missing. Camoufox and Playwright are never imported — `main()` is not
called, and the browser only enters the picture there.

Usage: fillProbe.py
Prints {"<scenario>": {"trace": [...], "error": "..."}} on stdout.
A filled value is never traced, printed, or returned.

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
    # server.py parses argv only inside main(), but keep it honest anyway.
    sys.argv = ["server.py", "--screenshots-dir", "/tmp"]
    spec.loader.exec_module(module)
    return module


class Handle:
    """One resolved DOM node.

    `mask_result` is what the page would answer when asked to mark this node:
    "stylesheet" on an ordinary page, "unmasked" on one whose CSP blocks the
    stylesheet and whose style object will not take the property either.
    """

    def __init__(self, trace, detach_before_fill=False, mask_result="stylesheet"):
        self.trace = trace
        self.detach_before_fill = detach_before_fill
        self.mask_result = mask_result
        self.marked = False

    def evaluate(self, js):
        # Recorded as a fact about the script, not its text: which one it is.
        if "setAttribute" in js and "data-domo-secret" in js:
            self.marked = True
            self.trace.append("handle.evaluate:mark")
            return self.mask_result
        if "removeAttribute" in js and "data-domo-secret" in js:
            self.marked = False
            self.trace.append("handle.evaluate:unmark")
            return True
        self.trace.append("handle.evaluate:other")
        return None

    def fill(self, value, timeout=None):
        if self.detach_before_fill:
            raise RuntimeError("Element is not attached to the DOM")
        self.trace.append("handle.fill")


class Frame:
    def __init__(self, trace, detach_before_fill=False, mask_result="stylesheet"):
        self.trace = trace
        self.url = "https://pizza.example/login"
        self.handle = Handle(trace, detach_before_fill, mask_result)

    def wait_for_selector(self, selector, timeout=None):
        self.trace.append("frame.wait_for_selector")
        return self.handle

    def fill(self, selector, value, timeout=None):
        self.trace.append("frame.fill")

    def click(self, selector, timeout=None):
        self.trace.append("frame.click")


class Page:
    def __init__(self, frame):
        self.url = "https://pizza.example/login"
        self.frames = [frame]

        class _Context:
            pages = [self]

        self.context = _Context()

    def wait_for_timeout(self, _ms):
        pass


def run(server, cmd, detach_before_fill=False, mask_result="stylesheet"):
    trace: list[str] = []
    frame = Frame(trace, detach_before_fill, mask_result)
    session = server.Session(Page(frame))
    out = {"trace": trace, "error": None, "marked": False, "result": None}
    try:
        result = session.handle(dict(cmd), "/tmp")
        # The value is never part of this: only whether the fill happened.
        out["result"] = {k: v for k, v in result.items() if k in ("ok", "mask", "frame")}
    except Exception as exc:  # noqa: BLE001 — the scenario under test
        out["error"] = type(exc).__name__
    out["marked"] = frame.handle.marked
    return out


def main() -> int:
    # Taken BEFORE server.py claims fd 1 (see the module docstring).
    out = os.fdopen(os.dup(1), "w")
    server = load_server()
    base = {"action": "fill", "selector": "#pass", "value": "hunter2", "frame": 0}
    result = {
        "masked": run(server, {**base, "mask": True}),
        "plain": run(server, base),
        "detached": run(server, {**base, "mask": True}, detach_before_fill=True),
        # A page that defeats the mark: nothing may be typed into it.
        "mask_blocked": run(server, {**base, "mask": True}, mask_result="unmasked"),
    }
    out.write(json.dumps(result))
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
