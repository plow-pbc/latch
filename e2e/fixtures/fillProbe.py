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
import time


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
                 document_token="doc-1", type_fails=False, typeable="single-line",
                 drops_keys=False, assign_fails=False, max_length=-1,
                 max_length_after=None, clear_fails=False, reformats=False,
                 field_type="text"):
        self.trace = trace
        # What the field itself will hold. -1 is "no cap", which is what an
        # element without a maxlength reports.
        self.max_length = max_length
        self.detach_before_fill = detach_before_fill
        self.partial_fill = partial_fill
        # The keystrokes fail before the first one lands, so the node is left
        # holding what the clear left it: nothing.
        self.type_fails = type_fails
        # What TYPEABLE_JS answers for this node: "" is a date, colour or range
        # widget -- assigned rather than typed, because its value is not the
        # characters it is handed. "multiline" is the textarea, the node that
        # KEEPS a line break as a character, so it is the kind whose value is
        # typed with the break still in it.
        self.typeable = typeable
        # A field that says it takes characters and then sanitises away every
        # one it will not hold -- a number input handed something that is not a
        # number. The keys are simply not applied, so the node keeps what the
        # leading assignment left it: nothing, for a value short enough to type
        # whole, and the assigned head for one that is not. Either way it is the
        # NODE that holds it, so every question asked afterwards sees the same
        # thing the real one would.
        self.drops_keys = drops_keys
        # What the field reports once it has taken keys, when that differs --
        # a card-number input lowers its cap the moment the brand is known.
        self.max_length_after = max_length_after
        # The node the page detached or froze along with moving the cap: the
        # clear that follows a mid-fill refusal cannot land on it.
        self.clear_fails = clear_fails
        # A field that REWRITES what it is given. "group" grows what it holds --
        # a card number gaining spaces as it is typed; "strip" shrinks it -- a
        # phone input dropping punctuation. Either way what it holds is not a
        # prefix of what was sent, which is exactly what KEYS_DROPPED_JS treats
        # as "took every key".
        self.reformats = reformats
        # `password` is the kind that never reformats, so what it holds has to
        # match exactly -- a dash in a password is content, not shaping.
        self.field_type = field_type
        # And one that will not take the value by assignment either, which is
        # the loud failure the keystroke path must never swallow.
        self.assign_fails = assign_fails
        self.mask_result = mask_result
        self.marked = marked
        # Which document this node is in, and what it currently holds. A fill
        # that fails leaves the value alone; one that half-lands changes it.
        self.document_url = document_url
        self.document_token = document_token
        self.value = value
        # What per-key delay the keystrokes carried, and the text they carried.
        # Only the LENGTH of that text is ever reported out of this file.
        self.typed_delay = None
        self.typed = None
        # The largest and smallest budget any key was handed -- the first key's
        # and the last's. They share one deadline, so the gap between them is
        # what the tail spent; a per-key timeout hands out the same number every
        # time and leaves no gap at all.
        self.key_timeout_max = None
        self.key_timeout_min = None
        # How many separate calls that text arrived in. One per character is
        # the property the segmented-code fix turns on: a key sent through the
        # handle lands in the node the mark is on, wherever focus has wandered.
        self.type_calls = 0

    def _cap(self):
        """The cap in force now: a field that moves it does so once it has keys."""
        if self.max_length_after is not None and self.typed is not None:
            return self.max_length_after
        return self.max_length

    def evaluate(self, js, *args):
        # Recorded as a fact about the script, not its text: which one it is.
        # Ordered most specific first: MASK_JS mentions setAttribute,
        # removeAttribute AND hasAttribute, so anything looser matches it by
        # accident and the scenario quietly tests nothing.
        if "__domoDocumentToken" in js:
            return self.document_token
        if "bare(" in js:
            wanted, exact = (args[0] if args else ["", False])
            held, wanted = (self.value or "").strip(), wanted.strip()
            if exact:
                return held == wanted
            seps = " \t\r\n-()./+,"
            bare = lambda t: "".join(c for c in t if c not in seps)  # noqa: E731
            return bare(held) == bare(wanted)
        if "maxLength" in js:
            # The real script reports a cap only for the element kinds
            # `maxlength` governs; a node standing in for one of those answers
            # its cap, and -1 is "uncapped" exactly as it is in the page.
            return {"cap": self._cap(), "password": self.field_type == "password"}
        if "tagName" in js:
            return self.typeable
        if "startsWith(now)" in js:
            wanted = args[0] if args else None
            now = self.value or ""
            return now != wanted and (wanted or "").startswith(now)
        if "=== previous" in js:
            previous = args[0].value if args and isinstance(args[0], _Handle) else (args[0] if args else None)
            now = self.value or ""
            return now == "" or now == previous
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
        """The assignment that opens a fill: everything ahead of the typed tail,
        which for a value short enough to type whole is the empty string.

        A node that has gone away fails HERE, which is the point of doing it
        first: nothing is typed into a field nobody can find.
        """
        # Only the clear that FOLLOWS the keys: for a value shorter than
        # TYPED_CHARS the head assignment is an empty fill too, and it runs
        # before anything is typed.
        if self.clear_fails and value == "" and self.typed is not None:
            self.trace.append("handle.clear-failed")
            raise RuntimeError("Element is not attached to the DOM")
        if self.detach_before_fill:
            self.trace.append("handle.assign-failed")
            raise RuntimeError("Element is not attached to the DOM")
        if self.assign_fails and self.typed is not None:
            # The fallback, after the keys were dropped: the field will not take
            # this value at all. Nothing landed and the caller has to hear so.
            self.trace.append("handle.assign-failed")
            raise RuntimeError("Cannot type text into input[type=number]")
        self.value = value
        self.trace.append("handle.assign")

    def type(self, text, delay=None, timeout=None):
        """The keystrokes. A failure is traced distinctly from a success:
        "did it try" and "did it land" are different questions, and what happens
        after a fill that did not land is the whole point of one of these
        scenarios."""
        self.typed_delay = delay
        # One entry per contiguous run of keys, not per key: the trace records
        # the SHAPE of the fill, and `type_calls` carries the count.
        if self.trace[-1:] != ["handle.type"]:
            self.trace.append("handle.type")
        if self.type_fails:
            # Not one key arrived: nothing is counted as typed, and the node
            # holds what the assignment left it.
            self.trace[-1] = "handle.type-failed"
            raise RuntimeError("Element is not attached to the DOM")
        self.typed = (self.typed or "") + text
        self.type_calls += 1
        # A millisecond per key, wherever in this body it falls: `timeout` is
        # already fixed by the time this runs, so what the spend moves is the
        # NEXT key's budget, which the caller computes from the same deadline.
        # Over a tail that is a gap this fixture caused rather than however many
        # microseconds the interpreter took between two statements. Playwright
        # spends the key's delay here.
        time.sleep(0.001)
        if self.key_timeout_max is None or timeout > self.key_timeout_max:
            self.key_timeout_max = timeout
        if self.key_timeout_min is None or timeout < self.key_timeout_min:
            self.key_timeout_min = timeout
        if self.drops_keys:
            return
        # Keys land ON what the assignment left, never instead of it -- which
        # is the only way a scenario can tell the head was assigned at all --
        # and are CLIPPED by whatever cap the field is reporting now. Without
        # the clip the only reachable variant is "nothing landed", which is the
        # one that cannot show what a refusal leaves behind in the page.
        cap = self._cap()
        landed = (self.value or "") + text
        if self.reformats == "strip":
            landed = "".join(c for c in landed if c.isalnum())
        elif self.reformats:
            bare = landed.replace(" ", "")
            landed = " ".join(bare[i:i + 4] for i in range(0, len(bare), 4))
        self.value = _clip(landed, cap)
        if self.partial_fill and self.type_calls > 1:
            # Some of it went in and then the field went away. It takes more
            # than one key for that to be interesting: what the node is left
            # holding has to be something a comparison could get wrong.
            self.trace[-1] = "handle.type-failed"
            raise RuntimeError("Element is not attached to the DOM")


def _clip(text, cap):
    """Clip the way a field does: `maxlength` counts UTF-16 code units.

    Slicing by code points instead would keep four emoji under a cap of four,
    where a browser keeps two -- and the fixture would then show a value landing
    whole that a real field had halved.
    """
    if cap < 0:
        return text
    return text.encode("utf-16-le")[:cap * 2].decode("utf-16-le", errors="ignore")


class Hidden(RuntimeError):
    """What a frame holding the field but refusing to show it answers with.

    Its own type, so a scenario can say WHICH frame's failure came back — the
    generic "selector not found" the loop falls back to is a RuntimeError too.
    """


class Detached(RuntimeError):
    """What a frame that went away answers with. Its own type for the same reason."""


class Frame:
    """One frame, with as many nodes as a scenario needs.

    `nodes` maps selector -> Handle. The default frame has one node under every
    selector asked for, which is what the single-command scenarios want; the
    ledger scenarios name their nodes and can take one away.
    """

    def __init__(self, trace, nodes=None, document_token="doc-1", hides=False, detached=False,
                 **node):
        self.trace = trace
        # A frame that HAS the field and will not show it, and one that went
        # away: the two failures the fill path ranks against each other.
        self.hides = hides
        self.detached = detached
        self.url = "https://pizza.example/login"
        self.document_token = document_token
        # The node's own behaviour is the node's. A frame that relayed every one
        # of those knobs made three signatures that had to be edited together
        # for each new one, which is churn the seam caused rather than the
        # scenarios needing it.
        self.handle = Handle(trace, document_token=document_token, **node)
        self.nodes = nodes

    def _node(self, selector):
        return self.handle if self.nodes is None else self.nodes.get(selector)

    def evaluate(self, expression, *args, **kwargs):
        if "__domoDocumentToken" in expression:
            return self.document_token
        return []          # the forms scanner, over no fields

    def query_selector(self, selector):
        return self._node(selector)

    def is_detached(self):
        return self.detached

    def wait_for_selector(self, selector, timeout=None):
        self.trace.append("frame.wait_for_selector")
        if self.detached:
            raise Detached("frame was detached")
        node = self._node(selector)
        if node is None:
            raise RuntimeError("selector not found: %s" % selector)
        if self.hides:
            raise Hidden("%s never became visible" % selector)
        return node


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

            # Session subscribes its response listener here at construction.
            def on(self, _event, _handler):
                pass

        self.context = _Context()

    def evaluate(self, expression, *args, **kwargs):
        return self.document_token

    def wait_for_timeout(self, _ms):
        pass

    def inner_text(self, _selector):
        return ""


def run(server, cmd, document_token="doc-1", **node):
    """One command against one frame holding one node. `node` is the Handle's."""
    trace: list[str] = []
    frame = Frame(trace, document_token=document_token, **node)
    page = Page(frame)
    session = server.Session(page)
    out = {"trace": trace, "error": None, "marked": False, "result": None, "value_kept": True,
           "ledgered": False}
    try:
        result = session.handle(dict(cmd), "/tmp")
        # The value is never part of this: only whether the fill happened, and
        # for a locate, what identity it reported.
        out["result"] = {k: v for k, v in result.items()
                         if k in ("ok", "mask", "frame", "frame_url", "frame_token", "cap", "fits")}
    except Exception as exc:  # noqa: BLE001 — the scenario under test
        out["error"] = type(exc).__name__
    out["marked"] = frame.handle.marked
    out["value_kept"] = frame.handle.value == node.get("value", "")
    out["ledgered"] = bool(session.masked)
    # The delay between keystrokes, which is what makes them keystrokes rather
    # than an assignment. A number, never anything derived from a value.
    out["typed_delay"] = frame.handle.typed_delay
    # How long a value was asked for, how many characters went in as keys, and
    # how many the node ended up holding. Lengths, never values.
    out["asked_len"] = len(cmd.get("value", "") or "")
    out["typed_len"] = None if frame.handle.typed is None else len(frame.handle.typed)
    # Whether a carriage return reached the keys. A boolean, never the text: the
    # typed string is the value, and nothing here may carry one out.
    out["typed_has_cr"] = frame.handle.typed is not None and "\r" in frame.handle.typed
    # One call per character is what keeps a key out of an unmarked sibling.
    out["type_calls"] = frame.handle.type_calls
    # The largest and smallest budget any key was handed -- the first key's and
    # the last's. A shared deadline is already counting down by the first, so
    # even that one is under the tail's whole budget, and the gap to the last is
    # what the tail spent. A per-key timeout hands out exactly the whole budget
    # every time: at the ceiling, and no gap.
    out["key_timeout_max"] = frame.handle.key_timeout_max
    out["key_timeout_min"] = frame.handle.key_timeout_min
    out["node_len"] = len(frame.handle.value or "")
    return out


def two_frames(server):
    """A fill that fails AFTER changing a node, on a page where the selector
    resolves in a later frame too.

    The caller named no frame, so the search walks them — and the question is
    whether a failure in the first one is allowed to become a success in the
    second. It must not: that leaves two fields holding something and reports
    the identity of the one that happened to work.
    """
    trace: list[str] = []
    first = Frame(trace, partial_fill=True, value="1 Elm St", document_token="doc-a")
    second = Frame(trace, document_token="doc-b")
    page = Page(second, extra_frames=[first])
    session = server.Session(page)
    out = {"error": None, "result": None}
    try:
        out["result"] = session.handle(
            {"action": "fill", "selector": "#pass", "value": "hunter2", "mask": True}, "/tmp")
    except Exception as exc:  # noqa: BLE001 — the scenario under test
        out["error"] = type(exc).__name__
    # Whether the frame BEHIND the failure was touched. A length, never a value.
    out["second_len"] = len(second.handle.value or "")
    out["first_changed"] = first.handle.value != "1 Elm St"
    out["trace"] = trace
    return out


def ranked(server, with_holder=True, holder_first=True):
    """Which frame's failure comes back.

    A frame that went away must not overwrite the answer from one that held the
    field and refused to show it, and must still be heard when it is the only
    thing that happened. Order does not decide it: a frames list is DOM order,
    and an advert frame sits above the payment one as often as below. The main
    frame comes after the siblings and has nothing.
    """
    trace: list[str] = []
    holder = Frame(trace, nodes={"#pass": Handle(trace)}, hides=True) if with_holder else None
    gone = Frame(trace, nodes={}, detached=True)
    siblings = [fr for fr in ([holder, gone] if holder_first else [gone, holder])
                if fr is not None]
    session = server.Session(Page(Frame(trace, nodes={}), extra_frames=siblings))
    out = {"error": None, "tried": 0}
    try:
        session.handle({"action": "fill", "selector": "#pass", "value": "x"}, "/tmp")
    except Exception as exc:  # noqa: BLE001 — the scenario under test
        out["error"] = type(exc).__name__
    out["tried"] = trace.count("frame.wait_for_selector")
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
        # A value carrying a newline, at a single-line field. The node could not
        # hold the break anyway -- an <input> strips it in value sanitization --
        # so it is normalized away and the rest still goes in as real keys, and
        # no Enter is ever sent at a form.
        "newline_single_line": run(server, {**base, "value": "one\ntwo"}),
        # The same at a single-line field, spelled with CR. This is what pins the
        # ORDER of the normalization: CR becomes LF before the strip removes it,
        # so no Enter is sent. Reversed, `type()` would press Enter mid-value and
        # submit the form with half a credential in it.
        "cr_single_line": run(server, {**base, "value": "one\rtwo"}),
        # A tab, which `type()` sends as the Tab key -- focus moves and no
        # character lands, so the keys can never carry this value. That is a
        # browser claim this fake cannot model; it and its siblings are listed
        # in docs/TESTING-THE-APP.md, "Browser behaviors the fill path rests on".
        "tab_value": run(server, {**base, "value": "one\ttwo"}),
        # And one whose tab sits in the assigned head. The guard is scoped to the
        # tail, which is all that gets typed, so this still ends on real keys --
        # widening it to the whole value would send every long tab-bearing value
        # to a bare assignment.
        "tab_outside_tail": run(server, {**base, "value": "one\t" + "x" * 2000}),
        # A break at a textarea, the node that keeps it as a character: it keeps
        # its keystrokes too.
        "newline_multiline": run(server, {**base, "value": "one\ntwo"},
                                 typeable="multiline"),
        # The rule is scoped to the TAIL, which is all that gets typed: a long
        # value whose newline sits in the head still ends on real keys, because
        # the head is assigned anyway.
        "newline_outside_tail": run(server, {**base, "value": "one\n" + "x" * 2000}),
        # CRLF at a textarea. `type()` sends CR and LF alike as Enter, so the
        # pair would press it twice where the node holds one break -- the server
        # normalizes before it splits head from tail, so the keys carry no CR and
        # normalizes CR and CRLF to a single LF. That Enter inserts a newline at
        # all is a browser claim this fake cannot model -- see
        # docs/TESTING-THE-APP.md, "Browser behaviors the fill path rests on".
        "crlf_multiline": run(server, {**base, "value": "one\r\ntwo"},
                              typeable="multiline"),
        # A date widget: its value is composed from something other than the
        # characters, so keystrokes land the wrong day or nothing at all.
        "not_typeable": run(server, {**base, "value": "2026-08-19"}, typeable=""),
        # The same widget holding something the vault masks. The question is
        # asked AFTER the mark goes on, which is a call site that did not exist
        # before the widget branch did.
        "not_typeable_masked": run(server, {**base, "mask": True, "value": "2026-08-19"},
                                   typeable=""),
        # A field that took the keys and then sanitised some of them away, so
        # the node does not hold what was asked for. Reporting that as a fill
        # would tell the caller a credential landed when it did not.
        "keys_dropped": run(server, {**base, "value": "hunter2"}, drops_keys=True),
        # And the field will not take it by assignment either. This is the loud
        # end of the path: nothing landed anywhere, so the caller hears about it
        # and the mark comes back off a field that is holding nothing.
        "keys_dropped_unfillable": run(server, {**base, "mask": True, "value": "hunter2"},
                                       drops_keys=True, assign_fails=True),
        # A credential right at the TYPED_CHARS boundary, typed whole. A
        # seven-character password passes at any value of that constant down to
        # seven, so the number is pinned by one the size it was chosen for.
        # `long_value` covers the other side: over-length, head assigned.
        "credential": run(server, {**base, "value": "k" * 64}),
        # Prose, not a credential: too long to type inside the budget. The bulk
        # is assigned and the field still ends on real keys.
        "long_value": run(server, {**base, "value": "x" * 2000}),
        # A long SECRET whose head was assigned and whose tail then broke off
        # partway: the node holds real credential content, so the mark stays and
        # it is ledgered. The short-value shape assigned nothing and cannot show
        # this.
        "orphan_mark_long": run(server, {**base, "mask": True, "value": "s" * 2000},
                                partial_fill=True, value="1 Elm St"),
        # The clear landed and then not one key did, so the node holds nothing.
        # A field holding nothing has nothing to conceal.
        "typing_never_started": run(server, {**base, "mask": True}, type_fails=True,
                                    value="1 Elm St"),
        # A field that will not hold the whole value. "hunter2" is 7; a cap of 4
        # means a real page would take "hunt" and submit that, or -- assigned --
        # take all 7 into a field a person could only have typed 4 into. Neither
        # is the value that was asked for, so nothing is written at all: the node
        # is untouched, unmarked, and the caller hears about it.
        "capped_secret": run(server, {**base, "mask": True}, max_length=4),
        "capped_plain": run(server, base, max_length=4),
        # The boundary: a value exactly the length of the cap fits, and the fill
        # is ordinary. Guards the check against being off by one.
        "at_cap": run(server, {**base, "value": "1234"}, max_length=4),
        # The cap MOVES under a fill already in progress: admitted at 20, lowered
        # to 4 once the field had keys, which is what a card-number input does
        # when the first digits identify the brand (15 for Amex against 16 for
        # the rest). The keys are clipped, the repair assigns -- and the
        # assignment asks the field again rather than trusting the answer the
        # fill was admitted on.
        "cap_lowered_mid_fill": run(server, {**base, "value": "hunter2"},
                                    max_length=20, max_length_after=4, drops_keys=True),
        "cap_lowered_mid_fill_masked": run(server, {**base, "mask": True, "value": "hunter2"},
                                           max_length=20, max_length_after=4, drops_keys=True),
        # The same move with the keys LANDING, clipped to the lowered cap --
        # what a real field does. The node is holding a prefix of the secret
        # when the repair refuses, so the refusal has to leave nothing behind.
        "cap_lowered_keys_landed": run(server, {**base, "value": "hunter2"},
                                       max_length=20, max_length_after=4),
        "cap_lowered_keys_landed_masked": run(server, {**base, "mask": True, "value": "hunter2"},
                                              max_length=20, max_length_after=4),
        # The clear cannot land either -- the page that moved the cap detached
        # the node. The cap answer still has to come back: replaced by the
        # clear's own failure it would fall to "check the selector", the message
        # this path exists to stop producing.
        "cap_lowered_clear_fails": run(server, {**base, "value": "hunter2"},
                                       max_length=20, max_length_after=4, clear_fails=True),
        # The same, concealed: the mask bookkeeping runs between the clear's
        # failure and the answer, and it asks the node questions. If one of
        # those replaced the refusal the concealed path would lose the cap
        # exactly where the unconcealed one keeps it.
        "cap_lowered_clear_fails_masked": run(server, {**base, "mask": True, "value": "hunter2"},
                                              max_length=20, max_length_after=4, clear_fails=True),
        # A space-inserting card input carrying maxlength 17 for an Amex it
        # renders as "3714 496353 98431". Comparing the 16 digits sent against
        # that cap says they fit -- different representations -- so this is
        # caught by asking the FIELD whether it took the last key instead.
        "reformatting_field_clips": run(
            server, {**base, "value": "4111111111111111"},
            max_length=19, max_length_after=17, reformats="group"),
        # The other direction, and the one that must NOT be refused: a phone
        # input stripping punctuation down to ten digits. Its last key changed
        # what the field holds, so the field took it -- an unchanged value with
        # room to spare is an edit absorbed, not a key rejected.
        # A stored value with a trailing space, into a card input that renders 16
        # digits as "4111 1111 1111 1111" and caps at exactly that. Every digit
        # lands and the space is absorbed, so a length comparison would have
        # called a correct fill a refusal and wiped it.
        "trailing_space_at_cap": run(
            server, {**base, "value": "4111111111111111 "},
            max_length=19, reformats="group"),
        # The same shape on a stripping control: the space goes, the digits stay.
        "trailing_space_stripped": run(
            server, {**base, "value": "555-123-4567 "},
            max_length=20, max_length_after=10, reformats="strip"),
        # A value carrying a letter outside ASCII. Python's `isalnum` counts it
        # and a `\w`-based JS class would not, so the field would have read as
        # partly missing and been wiped.
        "non_ascii_value": run(server, {**base, "value": "Jos\u00e9-1234"}, max_length=20),
        # A phone input declaring its TRUE cap up front -- 10, the digits it
        # keeps -- given 12 characters of punctuation it strips. Comparing the
        # sent length against that cap refused this before the node was even
        # touched; the digits are what cannot be reformatted away, and there are
        # exactly ten of them.
        # Equal LENGTH, different value: a field that drops punctuation out of a
        # credential. A count of what survives reformatting says seven either
        # way, so only comparing the stripped values catches it -- punctuation
        # in a password is content, not shaping.
        # The measure the exact rule changes: eight units whole, seven with the
        # dash treated as shaping. A cap of seven admits it only under the bare
        # measure, and a password's dash is not shaping.
        "secret_fits_only_if_dash_is_shaping": run(
            server, {**base, "value": "hunt-er2"}, max_length=7, field_type="password"),
        # A cardholder name whose field drops the space. Nothing is grouped
        # here -- the value has letters in it -- so the space is content and
        # "JonDoe" is not what was asked for, however ordinary the character.
        # Capacity on a value that does not fold: "Jon Doe" is seven units whole
        # and six with the space read as shaping, so a cap of six admits it only
        # under the bare measure -- and a name's space is not shaping.
        "name_fits_only_if_space_is_shaping": run(
            server, {**base, "value": "Jon Doe"}, max_length=6),
        # An international number: the leading + is grouping like the dashes, so
        # this still folds and still fills.
        "international_number_folds": run(
            server, {**base, "value": "+1 555-123-4567"}, max_length=20,
            max_length_after=11, reformats="strip"),
        "name_loses_its_space": run(
            server, {**base, "value": "Jon Doe"}, max_length=20, reformats="strip"),
        "punctuation_dropped_from_secret": run(
            server, {**base, "value": "hunt-er2"}, max_length=8, reformats="strip",
            field_type="password"),
        "strips_declared_cap_upfront": run(
            server, {**base, "value": "555-123-4567"}, max_length=10, reformats="strip"),
        "reformatting_field_shrinks": run(
            server, {**base, "value": "555-123-4567"},
            max_length=20, max_length_after=10, reformats="strip"),
        # maxlength="0" is valid HTML and holds nothing. -1 is the only value
        # that means uncapped, so 0 must refuse rather than read as "no cap".
        "zero_cap": run(server, {**base, "value": "x"}, max_length=0),
        # `maxlength` counts UTF-16 code units. Four emoji are 4 code points and
        # 8 units, so a code-point count would call this a fit and let the
        # browser clip it.
        "astral_over_cap": run(server, {**base, "value": "\U0001F600" * 4}, max_length=4),
        "detached": run(server, {**base, "mask": True}, detach_before_fill=True),
        # A page that defeats the mark: nothing may be typed into it.
        "mask_blocked": run(server, {**base, "mask": True}, mask_result="unmasked"),
        # A visible fill that fails: the node still holds whatever was in it,
        # which may be the last secret, so the mark must still be there.
        "plain_failed": run(server, base, detach_before_fill=True, marked=True),
        "ranked": ranked(server),
        "ranked_only_gone": ranked(server, with_holder=False),
        "ranked_gone_first": ranked(server, holder_first=False),
    }
    fill_pass = {"action": "fill", "selector": "#pass", "value": "hunter2", "frame": 0, "mask": True}
    fill_addr_at_pass = {"action": "fill", "selector": "#pass", "value": "1 Elm St", "frame": 0}
    # In the ledger scenarios the page carries an advert iframe ABOVE the one
    # that matters, so the field starts life at index 1 — which is exactly what
    # makes removing the sibling interesting.
    ledger_fill = {**fill_pass, "frame": 1}
    ledger_overwrite = {**fill_addr_at_pass, "frame": 1}
    observe = {"action": "forms"}
    result["two_frames"] = two_frames(server)
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
    # How much of a value the server types, so a test asserting the split reads
    # the number from the server rather than restating it.
    result["constants"] = {
        "typed_chars": server.TYPED_CHARS,
        "action_timeout_ms": server.DEFAULT_ACTION_TIMEOUT_MS,
        "typing_max_ms": server.TYPING_MAX_MS,
    }
    out.write(json.dumps(result))
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
