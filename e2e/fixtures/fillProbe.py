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
    stylesheet and whose style object will not take the property either. It can
    be changed after the fact, which is how a scenario says "and then the page
    stopped allowing it".
    """

    def __init__(self, trace, detach_before_fill=False, mask_result="stylesheet", marked=False):
        self.trace = trace
        self.detach_before_fill = detach_before_fill
        self.mask_result = mask_result
        self.marked = marked

    def evaluate(self, js):
        # Recorded as a fact about the script, not its text: which one it is.
        if "__domoDocumentToken" in js:
            return "doc-1"
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
        # A failed fill is traced too, and distinctly: "did it try" and "did it
        # land" are different questions, and what happens after a fill that did
        # not land is the whole point of one of these scenarios.
        if self.detach_before_fill:
            self.trace.append("handle.fill-failed")
            raise RuntimeError("Element is not attached to the DOM")
        self.trace.append("handle.fill")


class Frame:
    """One frame, with as many nodes as a scenario needs.

    `nodes` maps selector -> Handle. The default frame has one node under every
    selector asked for, which is what the single-command scenarios want; the
    ledger scenarios name their nodes and can take one away.
    """

    def __init__(self, trace, detach_before_fill=False, mask_result="stylesheet", marked=False,
                 nodes=None):
        self.trace = trace
        self.url = "https://pizza.example/login"
        self.handle = Handle(trace, detach_before_fill, mask_result, marked)
        self.nodes = nodes

    def _node(self, selector):
        return self.handle if self.nodes is None else self.nodes.get(selector)

    def evaluate(self, expression, *args, **kwargs):
        return []          # the forms scanner, over no fields

    def query_selector(self, selector):
        return self._node(selector)

    def wait_for_selector(self, selector, timeout=None):
        self.trace.append("frame.wait_for_selector")
        node = self._node(selector)
        if node is None:
            raise RuntimeError("selector not found: %s" % selector)
        return node

    def fill(self, selector, value, timeout=None):
        self.trace.append("frame.fill")

    def click(self, selector, timeout=None):
        self.trace.append("frame.click")


class Page:
    def __init__(self, frame):
        self.url = "https://pizza.example/login"
        self.frames = [frame]
        # What `DOC_TOKEN_JS` would return. A scenario changes it to say "a new
        # document"; changing only `url` says "a route change within this one".
        self.document_token = "doc-1"

        class _Context:
            pages = [self]

        self.context = _Context()

    def evaluate(self, expression, *args, **kwargs):
        return self.document_token

    def wait_for_timeout(self, _ms):
        pass

    def inner_text(self, _selector):
        return ""


def run(server, cmd, detach_before_fill=False, mask_result="stylesheet", marked=False):
    trace: list[str] = []
    frame = Frame(trace, detach_before_fill, mask_result, marked)
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


def ledger(server, script):
    """Run a sequence of commands against ONE session and report what the
    server's own mask ledger did. Values never leave this function."""
    trace: list[str] = []
    nodes = {"#pass": Handle(trace), "#addr": Handle(trace)}
    frame = Frame(trace, nodes=nodes)
    page = Page(frame)
    session = server.Session(page)
    steps = []
    for step in script:
        if step.get("navigate"):
            # A new document: fresh window, fresh token.
            page.url = step["navigate"]
            frame.url = step["navigate"]
            page.document_token = "doc-%s" % step["navigate"]
            steps.append({"step": "navigate", "result": None})
            continue
        if step.get("route"):
            # pushState: the URL moves, the document does not.
            page.url = step["route"]
            frame.url = step["route"]
            steps.append({"step": "route", "result": None})
            continue
        if step.get("rerender"):
            # The framework rebuilds the input: the value stays, the mark goes.
            nodes[step["rerender"]].marked = False
            steps.append({"step": "rerender", "result": None})
            continue
        if step.get("vanish"):
            nodes.pop(step["vanish"], None)
            steps.append({"step": "vanish", "result": None})
            continue
        if step.get("refuse"):
            nodes[step["refuse"]].mask_result = "unmasked"
            steps.append({"step": "refuse", "result": None})
            continue
        try:
            result = session.handle(dict(step["cmd"]), "/tmp")
            keep = {k: v for k, v in result.items() if k in ("ok", "mask")}
        except Exception as exc:  # noqa: BLE001
            keep = {"error": type(exc).__name__}
        steps.append({"step": step["cmd"]["action"], "result": keep})
    return {
        "steps": steps,
        "tracked": sorted("%d:%s" % t for t in session.masked.get(page, set())),
        "marked": {sel: node.marked for sel, node in nodes.items()},
    }


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
        # A visible fill that fails: the node still holds whatever was in it,
        # which may be the last secret, so the mark must still be there.
        "plain_failed": run(server, base, detach_before_fill=True, marked=True),
    }
    fill_pass = {"action": "fill", "selector": "#pass", "value": "hunter2", "frame": 0, "mask": True}
    fill_addr_at_pass = {"action": "fill", "selector": "#pass", "value": "1 Elm St", "frame": 0}
    observe = {"action": "forms"}
    result["ledger"] = {
        "kept": ledger(server, [{"cmd": fill_pass}, {"cmd": observe}]),
        "visible_overwrite": ledger(server, [
            {"cmd": fill_pass}, {"cmd": fill_addr_at_pass}, {"cmd": observe},
        ]),
        "navigated": ledger(server, [
            {"cmd": fill_pass}, {"navigate": "https://pizza.example/done"}, {"cmd": observe},
        ]),
        "wont_take": ledger(server, [
            {"cmd": fill_pass}, {"refuse": "#pass"}, {"cmd": observe},
        ]),
        "node_gone": ledger(server, [
            {"cmd": fill_pass}, {"vanish": "#pass"}, {"cmd": observe},
        ]),
        # An SPA route change plus a re-render: the URL moved, the document did
        # not, and the mark has to go back on before anything is observed.
        "same_document_route": ledger(server, [
            {"cmd": fill_pass},
            {"route": "https://pizza.example/step2"},
            {"rerender": "#pass"},
            {"cmd": observe},
        ]),
    }
    out.write(json.dumps(result))
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
