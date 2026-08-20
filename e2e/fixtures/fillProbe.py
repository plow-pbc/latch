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


class _Handle:
    """What `evaluate_handle` returns: a reference the server passes back."""

    def __init__(self, value):
        self.value = value

    def dispose(self):
        pass


class Handle:
    """One resolved DOM node.

    `mask_result` is what the page would answer when asked to mark this node:
    "stylesheet" on an ordinary page, "unmasked" on one whose CSP blocks the
    stylesheet and whose style object will not take the property either. It can
    be changed after the fact, which is how a scenario says "and then the page
    stopped allowing it".
    """

    def __init__(self, trace, detach_before_fill=False, mask_result="stylesheet", marked=False,
                 document_url="https://pizza.example/login", value="", partial_fill=False,
                 document_token="doc-1"):
        self.trace = trace
        self.detach_before_fill = detach_before_fill
        self.partial_fill = partial_fill
        self.mask_result = mask_result
        self.marked = marked
        # Which document this node is in, and what it currently holds. A fill
        # that fails leaves the value alone; one that half-lands changes it.
        self.document_url = document_url
        self.document_token = document_token
        self.value = value

    def evaluate(self, js, *args):
        # Recorded as a fact about the script, not its text: which one it is.
        # Ordered most specific first: MASK_JS mentions setAttribute,
        # removeAttribute AND hasAttribute, so anything looser matches it by
        # accident and the scenario quietly tests nothing.
        # Most specific first: DOC_WHERE_JS embeds DOC_TOKEN_JS, so a looser
        # match on the token would answer for both and this would test nothing.
        if "location.href" in js and "__domoDocumentToken" in js:
            return {"url": self.document_url, "token": self.document_token}
        if "__domoDocumentToken" in js:
            return self.document_token
        if "=== previous" in js:
            previous = args[0].value if args and isinstance(args[0], _Handle) else (args[0] if args else None)
            return (self.value or "") == previous
        if "el.value" in js:
            return self.value or ""
        if "setAttribute" in js and "data-domo-secret" in js:
            self.marked = True
            self.trace.append("handle.evaluate:mark")
            return self.mask_result
        if "removeAttribute" in js and "data-domo-secret" in js:
            self.marked = False
            self.trace.append("handle.evaluate:unmark")
            return True
        if "hasAttribute" in js:
            return self.marked
        self.trace.append("handle.evaluate:other")
        return None

    def evaluate_handle(self, js, *args):
        # Playwright hands back a reference that keeps the value in the page.
        # Here it is the string itself; the point is that the server never gets
        # to look at it, only to pass it back for comparison.
        return _Handle(self.evaluate(js, *args))

    def fill(self, value, timeout=None):
        # A failed fill is traced too, and distinctly: "did it try" and "did it
        # land" are different questions, and what happens after a fill that did
        # not land is the whole point of one of these scenarios.
        if self.partial_fill:
            # Some of it went in and then the field went away: the node is
            # holding something nobody can account for.
            self.value = value
            self.trace.append("handle.fill-failed")
            raise RuntimeError("Element is not attached to the DOM")
        if self.detach_before_fill:
            self.trace.append("handle.fill-failed")
            raise RuntimeError("Element is not attached to the DOM")
        self.value = value
        self.trace.append("handle.fill")


class Frame:
    """One frame, with as many nodes as a scenario needs.

    `nodes` maps selector -> Handle. The default frame has one node under every
    selector asked for, which is what the single-command scenarios want; the
    ledger scenarios name their nodes and can take one away.
    """

    def __init__(self, trace, detach_before_fill=False, mask_result="stylesheet", marked=False,
                 nodes=None, document_url="https://pizza.example/login", value="",
                 partial_fill=False, document_token="doc-1"):
        self.trace = trace
        self.url = "https://pizza.example/login"
        self.document_token = document_token
        self.handle = Handle(trace, detach_before_fill, mask_result, marked, document_url, value,
                             partial_fill, document_token)
        self.nodes = nodes

    def _node(self, selector):
        return self.handle if self.nodes is None else self.nodes.get(selector)

    def evaluate(self, expression, *args, **kwargs):
        if "location.href" in expression and "__domoDocumentToken" in expression:
            return {"url": "https://pizza.example/login", "token": self.document_token}
        if "__domoDocumentToken" in expression:
            return self.document_token
        # The forms scanner, over no fields. It reads its document's own URL
        # from inside the same evaluation, so the answer carries both.
        return {"url": "https://pizza.example/login", "fields": []}

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
    def __init__(self, frame, extra_frames=()):
        self.url = "https://pizza.example/login"
        # Siblings come FIRST, so removing one renumbers the frame that matters
        # — which is the whole point of the scenario that uses them.
        self.frames = [*extra_frames, frame]
        # What `DOC_TOKEN_JS` would return. A scenario changes it to say "a new
        # document"; changing only `url` says "a route change within this one".
        self.document_token = "doc-1"

        class _Context:
            pages = [self]

            # Session watches for popups through this; the stub only has to
            # accept the registration, since nothing here opens one.
            def on(self, event, handler):
                pass

        self.context = _Context()
        self.main_frame = frame

    def on(self, event, handler):
        pass  # nothing in this probe navigates

    def evaluate(self, expression, *args, **kwargs):
        return self.document_token

    def wait_for_timeout(self, _ms):
        pass

    def inner_text(self, _selector):
        return ""


def run(server, cmd, detach_before_fill=False, mask_result="stylesheet", marked=False,
        document_url="https://pizza.example/login", value="", partial_fill=False,
        document_token="doc-1"):
    trace: list[str] = []
    frame = Frame(trace, detach_before_fill, mask_result, marked, document_url=document_url,
                  value=value, partial_fill=partial_fill, document_token=document_token)
    session = server.Session(Page(frame))
    out = {"trace": trace, "error": None, "marked": False, "result": None, "value_kept": True,
           "ledgered": False}
    try:
        result = session.handle(dict(cmd), "/tmp")
        # The value is never part of this: only whether the fill happened, and
        # for a locate, what identity it reported.
        out["result"] = {k: v for k, v in result.items()
                         if k in ("ok", "mask", "frame", "frame_url", "frame_token")}
    except Exception as exc:  # noqa: BLE001 — the scenario under test
        out["error"] = type(exc).__name__
    out["marked"] = frame.handle.marked
    out["value_kept"] = frame.handle.value == value
    out["ledgered"] = bool(session.masked)
    return out


def ledger(server, script):
    """Run a sequence of commands against ONE session and report what the
    server's own mask ledger did. Values never leave this function."""
    trace: list[str] = []
    nodes = {"#pass": Handle(trace), "#addr": Handle(trace)}
    frame = Frame(trace, nodes=nodes)
    # An advert iframe sitting above the one that matters, so a scenario can
    # take it away and renumber everything below it. It carries a field under
    # the SAME selector on purpose: a lookup that finds the right selector in
    # the wrong document would mark this one, and that has to be visible.
    sibling_nodes = {"#pass": Handle(trace)}
    sibling = Frame(trace, nodes=sibling_nodes, document_token="doc-sibling")
    page = Page(frame, extra_frames=[sibling])
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
        if step.get("drop_sibling"):
            page.frames = [f for f in page.frames if f is not sibling]
            steps.append({"step": "drop_sibling", "result": None})
            continue
        if step.get("frame_navigated"):
            # The frame holding the field went somewhere else: new document,
            # new token, nothing of the old one left on the page.
            frame.document_token = step["frame_navigated"]
            steps.append({"step": "frame_navigated", "result": None})
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
        "tracked": sorted("%s:%s" % t for t in session.masked.get(page, set())),
        "marked": {sel: node.marked for sel, node in nodes.items()},
        # The same selector in the frame next door. Nothing should ever mark it.
        "sibling_marked": sibling_nodes["#pass"].marked,
    }


def main() -> int:
    # Taken BEFORE server.py claims fd 1 (see the module docstring).
    out = os.fdopen(os.dup(1), "w")
    server = load_server()
    base = {"action": "fill", "selector": "#pass", "value": "hunter2", "frame": 0}
    # The device approved THIS document before it went to the vault.
    approved = {"frame_token": "doc-1"}
    result = {
        "masked": run(server, {**base, "mask": True}),
        # Same index, different document: the frame was swapped while the value
        # was being fetched. A new document means a new token.
        "frame_moved": run(server, {**base, "mask": True, **approved}, document_token="doc-2"),
        "frame_same": run(server, {**base, "mask": True, **approved}),
        # The SPA rewrote its address bar during the lookup. Same document, same
        # node, same token — nothing was replaced, so nothing is refused.
        "route_changed_during_lookup": run(server, {**base, "mask": True, **approved},
                                           document_url="https://pizza.example/login/step2"),
        # The mark takes and the fill then times out, over a field that already
        # held something ordinary.
        "orphan_mark": run(server, {**base, "mask": True}, detach_before_fill=True,
                           value="1 Elm St"),
        # Half of it landed before the field went away: the node is holding
        # something unaccounted for, so the mark stays on and is ledgered.
        "orphan_mark_partial": run(server, {**base, "mask": True}, partial_fill=True,
                                   value="1 Elm St"),
        # The half that landed happens to share a 32-bit hash with what was
        # there before ("BB" and "Aa" do). A fingerprint would call that
        # unchanged and strip the mark off a field now holding a credential.
        "orphan_mark_collision": run(server, {**base, "mask": True, "value": "Aa"},
                                     partial_fill=True, value="BB"),
        # What `locate` hands the device: the identity the fill will be checked
        # against, alongside the url the origin is checked against.
        "located": run(server, {"action": "locate", "selector": "#pass"}),
        # The node was already carrying a secret when this fill failed: its mark
        # is not ours to take off.
        "orphan_mark_premarked": run(server, {**base, "mask": True}, detach_before_fill=True,
                                     marked=True, value="hunter2"),
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
    # In the ledger scenarios the page carries an advert iframe ABOVE the one
    # that matters, so the field starts life at index 1 — which is exactly what
    # makes removing the sibling interesting.
    ledger_fill = {**fill_pass, "frame": 1}
    ledger_overwrite = {**fill_addr_at_pass, "frame": 1}
    observe = {"action": "forms"}
    result["ledger"] = {
        "kept": ledger(server, [{"cmd": ledger_fill}, {"cmd": observe}]),
        "visible_overwrite": ledger(server, [
            {"cmd": ledger_fill}, {"cmd": ledger_overwrite}, {"cmd": observe},
        ]),
        "navigated": ledger(server, [
            {"cmd": ledger_fill}, {"navigate": "https://pizza.example/done"}, {"cmd": observe},
        ]),
        "wont_take": ledger(server, [
            {"cmd": ledger_fill}, {"refuse": "#pass"}, {"cmd": observe},
        ]),
        "node_gone": ledger(server, [
            {"cmd": ledger_fill}, {"vanish": "#pass"}, {"cmd": observe},
        ]),
        # A sibling iframe above this one is removed, so every index below it
        # shifts. The field is found by its document, not its number.
        "sibling_frame_removed": ledger(server, [
            {"cmd": ledger_fill},
            {"drop_sibling": True},
            {"rerender": "#pass"},
            {"cmd": observe},
        ]),
        # The frame holding the field navigated: its document is gone, and with
        # it anything anyone was keeping about the fields it held.
        "child_frame_navigated": ledger(server, [
            {"cmd": ledger_fill},
            {"frame_navigated": "doc-elsewhere"},
            {"cmd": observe},
        ]),
        # An SPA route change plus a re-render: the URL moved, the document did
        # not, and the mark has to go back on before anything is observed.
        "same_document_route": ledger(server, [
            {"cmd": ledger_fill},
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
