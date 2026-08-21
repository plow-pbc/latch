#!/usr/bin/env python3.12
"""Camoufox browser server for Domo.

Started directly by the device supervisor (BrowserHost). Speaks JSON lines over
stdio: requests on stdin ({"id": N, "action": ..., ...}), responses on the
protocol channel ({"id": N, "result": ...} | {"id": N, "error": ...}).

The protocol channel is a dup of the original stdout taken before anything else
runs; fd 1 is then redirected to stderr so that Camoufox/Playwright/Firefox
noise can never corrupt the protocol. A single ready line
{"status": "ready", ...} is emitted only after the browser is actually up.

Exit paths — all of them close the Camoufox context so Firefox children die:
SIGTERM, a {"action": "quit"} request, or EOF on stdin (supervisor death).

Adapted from plow-pbc/camoufox-cli scripts/camoufox_cli.py (see UPSTREAM.md).
"""

import argparse
import base64
import collections
import json
import os
import re
import signal
import sys
import time

# Claim the protocol channel before any import can print to stdout.
_RESP = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)

# camoufox's launcher calls screeninfo.get_monitors(), whose macOS backend goes
# through AppKit; the first window-server connection registers this python
# process with LaunchServices, and a Foreground registration puts a Python
# rocket in the Dock. The bundled runtime's Python.app carries LSUIElement in
# its Info.plist (build-browser-runtime.mjs patches it), which is the real fix
# — LaunchServices reads the on-disk plist, so this in-process copy runs too
# late to prevent a brief flash. Kept as a backstop for unbundled interpreters
# (DOMO_BROWSER_CMD dev runs against a stock python). Firefox itself is a
# separate process with its own bundle, unaffected either way.
if sys.platform == "darwin":
    try:
        from Foundation import NSBundle

        NSBundle.mainBundle().infoDictionary()["LSUIElement"] = "1"
    except Exception:  # noqa: BLE001 — cosmetic; never block startup on it
        pass

MAX_ERROR_LEN = 500

# How many refused requests one reply can carry back. The relay buffers a whole
# exchange, so a chatty page must not be able to park one; a handful of the most
# recent is what says "you are blocked". Drained by every reply, so this rarely
# fills; BrowserHost's ring is the one that accumulates, and carries the note
# about what that costs.
MAX_FAILED_REQUESTS = 5

# How many in-flight requests are remembered by who asked for them. A page can
# ask for a great many things; only the ones that come back refused are ever
# looked up, and one that has been forgotten simply names nobody.
MAX_REMEMBERED_REQUESTS = 200

# Kept off a refused request beyond status/method/origin/initiator. Never a
# body -- a body can echo a submitted credential -- and never an arbitrary
# header: Set-Cookie and friends live there. Retry-After says "wait" rather
# than "you are blocked", and its ABSENCE on a 429 is diagnostic in itself;
# Server usually distinguishes an origin rate-limiting us from a bot vendor
# refusing us.
FAILED_REQUEST_HEADERS = ("retry-after", "server")


def _origin(url):
    """Scheme and host, and nothing else.

    A url is the page's to choose, and every other part of one can carry a
    secret: a query (B2C hangs tx=StateProperties= there), userinfo, and a path
    as much as either -- /reset/<token> is a url a site really sends. The origin
    is the part that says who refused, which is the whole diagnosis, and the
    only part nobody can write anything into.
    """
    m = re.match(r"^([a-z][a-z0-9+.-]*://)(?:[^/@]*@)?([^/?#]*)", url, flags=re.I)
    return "" if m is None else m.group(1) + m.group(2).split("@")[-1]

# How long one element action waits by default. Sized like the `goto` budget
# above it: a single action has to answer inside the device's 15 s host cap and
# the relay's ~20 s per-exchange ceiling, and a click that has not landed in
# three seconds is usually telling the agent something -- so it fails fast and
# the agent looks at the page. `click` takes a caller-supplied `timeout_ms`
# instead when the agent knows the page is slow; the device clamps it.
DEFAULT_ACTION_TIMEOUT_MS = 3000

# How often a click re-scans the frames for its selector while waiting for it to
# appear. The scan itself is instant; this is just how long it sleeps between.
SCAN_INTERVAL_MS = 50

# What every action that moves the page gives it to settle afterwards, so the
# answer describes where the page ended up rather than where it was mid-flight.
SETTLE_MS = 1000

# A fill TYPES its value wherever it can rather than assigning it: a field that
# goes from empty to complete with no keydown/keypress/keyup at all is the
# cheapest signal an interrogating defense has. `_type_value` owns which nodes
# and which values that holds for, and `TYPEABLE_JS` below owns why a given
# node takes no keys. Typing costs a delay per character and an agent may fill
# a field with prose, so only the last TYPED_CHARS go through `el.type` and the
# bulk ahead of them is assigned. That number is a statement about credentials
# rather than a latency derivation: an ordinary password, a card number or a
# one-time code is shorter than this and is typed whole. Nothing enforces that
# a released value fits -- a long API key or a JWT does not -- and one that
# does not lands with its head assigned and its last TYPED_CHARS typed, which
# still puts the field's last characters through the keyboard.
#
# What each character's `el.type(ch, delay=...)` call is given. It is handed one
# character at a time, so it is spent inside that call rather than between two
# of them -- the per-call cost is KEY_OVERHEAD_MS below. What Playwright then
# does with it, and whether the character produces key events at all, is a
# browser assumption the suite cannot see: docs/TESTING-THE-APP.md.
KEY_DELAY_MS = 45
# What a key may cost beyond its delay: the round trip that dispatches it and
# the actionability check in front of it. A few milliseconds on a local page.
KEY_OVERHEAD_MS = 30
# A fill's TIMED cost is DEFAULT_ACTION_TIMEOUT_MS three times (resolve, assign,
# and the assignment a dropped-keys fallback makes) plus TYPING_MAX_MS, and that
# has to stay under what the device gives a browser action before it gives up on
# it -- `actionTimeoutMs` in deviceAgent.ts, which fillSecretMasking.test.ts
# reads there and asserts this sum against, in "keeps the timed budgets under
# the cap the device arms". TYPING_MAX_MS is derived from TYPED_CHARS, so
# raising the credential length has to answer to that cap. Nothing here is told
# when the device does give up -- it drops its pending entry and sends this
# process nothing -- so a fill that ran past it would go on typing a credential
# into a page whose answer nobody is waiting for. A fill searches the frames on
# its own per-frame default, so that sum covers one that names its frame on a
# page that runs script; two spends are outside it and neither is bounded: a
# caller that names no frame pays DEFAULT_ACTION_TIMEOUT_MS per frame it rules
# out (#96), and every fill makes `evaluate` calls that take no timeout at all,
# so a page that will not run script hangs regardless.
TYPED_CHARS = 64
TYPING_MAX_MS = TYPED_CHARS * (KEY_DELAY_MS + KEY_OVERHEAD_MS)


FIELD_JS = """() => Array.from(document.querySelectorAll("input,select,textarea")).slice(0,40).map(el => {
    let lab = "";
    if (el.labels && el.labels[0]) lab = el.labels[0].textContent.trim();
    if (!lab) lab = el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
    // A field the vault masks, and any password box whoever filled it, reports
    // only that it holds something. `filled` keeps such a field distinguishable
    // from an empty one, so a form can still be checked for completeness.
    const secret = el.hasAttribute("data-domo-secret") || el.type === "password";
    const val = el.value || "";
    return {
      tag: el.tagName.toLowerCase(), type: el.type || "", name: el.name || "",
      id: el.id || "", label: lab,
      placeholder: el.getAttribute("placeholder") || "",
      maxlength: el.getAttribute("maxlength") || "",
      options: el.tagName === "SELECT"
        ? Array.from(el.options).map(o => o.value).filter(Boolean).slice(0, 40) : [],
      secret: secret, filled: val.length > 0,
      value: secret ? "" : val.substring(0, 50)
    };
  })"""

LINKS_JS = """() => {
    const seen = new Set();
    return Array.from(document.querySelectorAll("a[href]"))
        .filter(a => { const t = a.textContent.trim(); if (!t || t.length > 80 || seen.has(t)) return false; seen.add(t); return true; })
        .slice(0, 50).map(a => ({text: a.textContent.trim(), href: a.href}));
}"""

TABLES_JS = """() => Array.from(document.querySelectorAll("table")).map(t => ({
    headers: Array.from(t.querySelectorAll("th")).map(th => th.textContent.trim()),
    rows: Array.from(t.querySelectorAll("tr")).slice(1).slice(0,20).map(tr =>
        Array.from(tr.querySelectorAll("td")).map(td => td.textContent.trim()))
}))"""


# Marking a secret the vault masks, at the moment it is filled: one attribute on
# the element, and one stylesheet rule per document that renders anything
# carrying it as discs. An attribute is used rather than an inline style because
# React manages the style prop and clobbers it on re-render, while it leaves
# attributes it has never heard of alone. The rule is injected at most once --
# a document that already carries it is left as it is.
MASK_JS = """(el) => {
    // Whether this node was ALREADY masked decides what to undo if the mark
    // does not take: a field that was carrying a secret keeps its tag, while
    // one that was not must be handed back exactly as it was found. Leaving the
    // tag on an ordinary field withholds its value from `forms` for good.
    const wasMarked = el.hasAttribute("data-domo-secret");
    el.setAttribute("data-domo-secret", "");
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    const masked = () => {
        if (!win || !win.getComputedStyle) return false;
        const cs = win.getComputedStyle(el);
        if (!cs) return false;
        return (cs.getPropertyValue("-webkit-text-security") || cs.webkitTextSecurity) === "disc";
    };
    if (!doc.getElementById("domo-secret-style")) {
        const style = doc.createElement("style");
        style.id = "domo-secret-style";
        style.textContent = "[data-domo-secret]{-webkit-text-security:disc}";
        (doc.head || doc.documentElement).appendChild(style);
    }
    // The stylesheet is not enough on its own: a page whose CSP omits
    // 'unsafe-inline' from style-src blocks a <style> element outright, and the
    // mark would then be an attribute that changes nothing while the value
    // renders in the clear. So the question is not "did we inject it" but "is
    // this node actually masked", which is what the computed style answers.
    if (masked()) return "stylesheet";
    // Setting a property directly on the element's style object is the one
    // route CSP does not police -- unlike a style attribute or cssText, which
    // style-src blocks exactly as it blocks a <style> element.
    el.style.setProperty("-webkit-text-security", "disc");
    el.style.webkitTextSecurity = "disc";
    if (masked()) return "inline";
    if (!wasMarked) {
        el.removeAttribute("data-domo-secret");
        el.style.removeProperty("-webkit-text-security");
    }
    return "unmasked";
}"""

# Which document this is. A token is stamped on `window` the first time it is
# asked for and read back afterwards: a new document gets a fresh `window` and
# therefore a fresh token, while a same-document navigation -- pushState, a
# hash change, history.back within an SPA -- keeps both. Non-enumerable, so it
# does not show up in anything the page or the agent enumerates.
#
# The URL cannot answer this question. An SPA route change rewrites it without
# replacing the document, and treating that as a new page threw away the record
# of which fields were masked -- while a re-rendered controlled input kept the
# secret and lost the marker, so the next screenshot showed it.
DOC_TOKEN_JS = """() => {
    const w = window;
    if (!w.__domoDocumentToken) {
        Object.defineProperty(w, "__domoDocumentToken", {
            value: Math.random().toString(36).slice(2) + Date.now().toString(36),
            configurable: true,
        });
    }
    return w.__domoDocumentToken;
}"""

# What KIND of typing this node takes, or "" for none. `type()` refuses nothing
# -- it focuses whatever it is given and sends the keys -- so every node
# `fill()` treats specially has to be recognised here instead. The empty answer
# is the whole hazard: "yes" typed at a checkbox toggles nothing and answers ok,
# a <select> changes option by type-ahead, a date input takes its segments in
# whatever order the locale puts them (typing "2026-08-19" lands 6081-02-02,
# silently), a colour or a range refuses keys outright, and a hidden input
# cannot hold focus at all -- so the characters, on the credential path a
# secret's, land wherever focus already was. Everything answered "" is ASSIGNED,
# which is exactly what it got before there was typing: the same value where
# `fill()` sets one, the same loud refusal where it will not.
#
# Only a <textarea> and an <input> of a text-carrying type are typed at. An
# editing host -- contenteditable, a designMode body -- is deliberately neither:
# the credential submits this exists for are <input>, and admitting arbitrary
# hosts cost a second editability taxonomy (which declared attribute values
# count, which embedded and non-rendered tags to refuse before reading it) for a
# case no machine here reaches. Such a node is assigned, as it was before typing.
#
# The two kinds differ on whether the node holds a line break: a <textarea>
# holds one as a character, an <input>'s value sanitization strips it.
TYPEABLE_JS = """(el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return el.disabled || el.readOnly ? "" : "multiline";
    if (tag !== "input") return "";
    const typed = ["text", "email", "password", "search", "tel", "url", "number"];
    if (!typed.includes(el.type)) return "";
    return el.disabled || el.readOnly ? "" : "single-line";
}"""

# How a node holds its text: `value` for an input or a textarea, `textContent`
# for anything else. Typing only reaches the first two, but every node reaches
# the ASSIGNMENT path -- so the snapshot and nothing-landed questions below are
# still asked about a contenteditable. Asking an input for its textContent, or a
# contenteditable for its value, reads the node as empty, which would call every
# fill dropped and every failed fill harmless, so all of them ask through this.
_HELD = "(typeof el.value === 'string' ? el.value : (el.textContent || ''))"

# What a node is holding, captured before a fill so a failure has something
# exact to be compared against. It stays in the page as a handle and is compared
# there, so it never crosses the wire. A hash was tried and is not good enough:
# "BB" and "Aa" share one, and a partial fill that collided would look unchanged
# and have its mark taken off, which is the one outcome that must never happen.
VALUE_SNAPSHOT_JS = f"""(el) => {_HELD}"""

# Whether the keys failed to land, in the only two shapes an assignment could
# repair: the field took none of them, or it took a prefix and stopped. A number
# input sanitises away anything it will not hold; a maxlength truncates. A field
# that REFORMATS what it was given -- a card number, a phone -- took every key
# and holds something else on purpose, so it is not a prefix and is left alone.
KEYS_DROPPED_JS = f"""(el, wanted) => {{
    const now = {_HELD};
    return now !== wanted && wanted.startsWith(now);
}}"""

# Whether a fill that failed left anything behind. Unchanged is one way to hold
# nothing unaccounted for; empty is the other -- a fill assigns before it types,
# so a failure at the first key leaves the node holding nothing, and a node
# holding nothing has nothing to conceal.
NOTHING_LANDED_JS = f"""(el, previous) => {{
    const now = {_HELD};
    return now === '' || now === previous;
}}"""

# Whether a node is already carrying the mark, asked before anything touches it.
WAS_MARKED_JS = """(el) => el.hasAttribute("data-domo-secret")"""


# How much this field will hold, and -1 when it does not say. `maxLength`
# reflects the attribute even on kinds the browser never enforces it for --
# `<input type="number" maxlength="4">` is a common authoring mistake -- so
# reading one there would turn a stray attribute into a refused fill.
FIELD_CAP_JS = """(el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return el.maxLength;
    if (tag !== "input") return -1;
    return ["text", "search", "url", "tel", "email", "password"].includes(el.type)
        ? el.maxLength
        : -1;
}"""

# Is the field holding exactly what was put into it? Compared IN THE PAGE, the
# way the prefix test is: the value goes in, a boolean comes back.
#
# Exactly, with no allowance for what the field might have been entitled to
# change. Deciding that a difference is acceptable needs to know what the value
# MEANS -- whether a space belongs to a card number's grouping or to somebody's
# name -- and nothing here knows that. So this reports the difference and lets
# the layers that do know decide what it is worth.
HELD_MATCHES_JS = f"""(el, wanted) => {_HELD} === wanted"""

UNMASK_JS = """(el) => {
    el.removeAttribute("data-domo-secret");
    if (el.style) {
        el.style.removeProperty("-webkit-text-security");
    }
    return true;
}"""


def _respond(payload):
    _RESP.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _RESP.flush()


def _collapse_breaks(value):
    """CR and CRLF become one LF. Shared, so the measure below and the fill
    that follows it can never disagree about what was sent."""
    return value.replace("\r\n", "\n").replace("\r", "\n")


def _arrives_as(value, kind):
    """The value as this node will receive it, in units.

    A node that is not multiline drops the breaks entirely, so a value carrying
    one arrives shorter than it was given. Asked of the kind rather than assumed
    either way: guessing short would let an over-cap value into a textarea and
    guessing long would refuse one that fits an input.
    """
    arriving = _collapse_breaks(value)
    return _utf16_units(arriving if kind == "multiline" else arriving.replace("\n", ""))


def _utf16_units(value):
    """What `maxlength` counts: UTF-16 code units, not code points.

    An astral character is one code point and two units, so counting code points
    would call four emoji a fit for a field that holds two. `surrogatepass`
    because a lone surrogate makes a plain encode raise.
    """
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def _kept(el, attempted):
    """`{"altered": True}` when the field is not holding what went into it.

    A fact, not a verdict, and absent when there is nothing to say. Whether a
    difference matters depends on what the value means -- a card input renders
    the digits it was given with spaces in them and has changed nothing that
    counts, while a name field dropping a space has changed somebody's name --
    and that is not knowable here. It is knowable to the device, which fetched
    the value and knows which vault field it came from, and to the agent, which
    can see the page. So this says what happened and they decide what it is
    worth.
    """
    return {} if el.evaluate(HELD_MATCHES_JS, attempted) else {"altered": True}


def _type_value(el, value, kind):
    """Put `value` into a resolved node so that the field ends on real keys.

    Returns the string it actually attempted, which is not always the one it was
    given: a single-line node cannot take a break, so the caller comparing what
    the field kept has to compare against this rather than against `value`.

    The node's KIND -- a text-carrying input, a textarea, or neither -- is asked
    for by the caller, which needs it to measure the cap, and handed in rather
    than asked again. One that answers "" is assigned whole,
    exactly as this always did, and so is a value whose typed tail carries a tab.

    The rest have their value normalized to what that node can HOLD before head
    and tail are split: one LF per break where the node keeps breaks at all, and
    none at an <input>, whose value sanitization strips them anyway. Every
    comparison below then speaks the string the node ends up with, and the tail
    cannot press Enter at a form by construction rather than by a branch.

    Of that normalized value, everything before the last TYPED_CHARS is assigned
    in one go -- that is the `el.fill()` the rest of this exists to avoid, used
    deliberately, because a field an agent filled with prose cannot be typed key
    by key inside the budget. What a defense samples is that keys arrived at the
    field at all, and they do: the tail is always typed, and a credential is
    shorter than the tail. That leading assignment doubles as the clear.

    The tail goes in one key at a time THROUGH THE HANDLE, which refocuses the
    marked node before each. A segmented one-time-code control moves focus to
    the next box on every `input` event, and one `el.type(tail)` call sends its
    remaining keys wherever focus went -- five digits of a live code into five
    sibling fields the mark was never put on, readable from `forms` and from a
    screenshot. Refocusing per key keeps every character in the node the device
    approved, and a node that goes away raises rather than typing on. What it
    does NOT do is fill such a control: box one refuses every key after the
    first, so the fallback below assigns the whole code into it (an assignment
    ignores `maxlength`) and the form is left unsubmittable. That is the
    deliberate trade -- the credential stays in the node the owner approved, and
    a segmented control takes one fill per box.

    A node that has gone away raises out of the first question asked of it, and
    every path from here on leaves the caller's failure handling to unwind it.
    """
    if not kind:
        el.fill(value, timeout=DEFAULT_ACTION_TIMEOUT_MS)
        return value
    # Everything below compares against `value` -- the prefix test that decides
    # whether the keys landed, and the assignment that repairs them when they did
    # not. Each has to speak the string the node will actually HOLD, or it
    # answers about a value that never existed anywhere.
    #
    # CR and CRLF collapse to one LF, and a node whose kind is not "multiline"
    # loses the break here. That is what lets a break-bearing value
    # still go in as real keys, and why the tail can never press Enter at a form
    # -- by construction, rather than by a branch that gives the keystrokes up.
    # The browser behavior underneath is in docs/TESTING-THE-APP.md.
    value = _collapse_breaks(value)
    if kind != "multiline":
        value = value.replace("\n", "")
    # A tab is the one character no normalization can rescue -- the keys cannot
    # carry it -- so a value holding one in the part that WOULD be typed is
    # assigned whole instead, the path it always had. One in the head is not
    # this branch's business: the head is assigned either way.
    #
    # Assigning is not the same as the node keeping it. What an input does with
    # an edge tab, and which types drop one, is in docs/TESTING-THE-APP.md --
    # stated once there because restating it here put the copies out of step.
    if "\t" in value[-TYPED_CHARS:]:
        el.fill(value, timeout=DEFAULT_ACTION_TIMEOUT_MS)
        return value
    el.fill(value[:-TYPED_CHARS], timeout=DEFAULT_ACTION_TIMEOUT_MS)
    # The whole tail draws on ONE budget, not one per key: a per-key timeout of
    # the tail's own budget would let TYPED_CHARS of them stack up to that many
    # times what a single call could ever spend, and past the device's cap.
    deadline = time.monotonic() + TYPING_MAX_MS / 1000
    for ch in value[-TYPED_CHARS:]:
        left = (deadline - time.monotonic()) * 1000
        if left <= 0:
            raise RuntimeError("typing outran its budget")
        el.type(ch, delay=KEY_DELAY_MS, timeout=left)
    if el.evaluate(KEYS_DROPPED_JS, value):
        # The field did not take the keys. Assign it, which is what this did
        # before there were keystrokes at all: it either lands the value or it
        # raises. What it must never do is report a value that is not there.
        el.fill(value, timeout=DEFAULT_ACTION_TIMEOUT_MS)
    return value


def _parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--screenshots-dir", required=True)
    p.add_argument("--executable", default=None, help="Camoufox binary path (bypasses the shared cache)")
    p.add_argument("--profile-dir", default=None, help="Persistent profile dir; omit for ephemeral")
    p.add_argument("--headed", action="store_true")
    return p.parse_args()


class Session:
    """One live browser + the currently active page.

    It also remembers which fields on which page it has masked. That has to live
    here rather than in the device: the device can name a selector, but only
    this side can tell whether the node behind it is still the one that was
    filled, still carries the mark, and is still on the page it was filled on.
    A ledger kept at arm's length goes stale in exactly the ways that matter --
    it survives a visible overwrite and a navigation, and re-marking from it
    then hides ordinary data.
    """

    def __init__(self, page):
        self.page = page
        # page -> {(document token, selector)} that hold something concealed.
        # A frame INDEX cannot be the key: removing an iframe above this one
        # renumbers everything below it, and the mark would then be put back on
        # whatever inherited the number while the field that needs it goes bare
        # into the next screenshot. A document token names one document for as
        # long as it exists and never names another.
        self.masked = {}
        # page -> the document it was showing when we last looked, so a real
        # navigation can be noticed however it happened and a route change
        # within one document is not mistaken for one.
        self.seen_document = {}
        # Requests the site itself refused, oldest first, waiting for the next
        # reply to carry them out. Subscribed on the CONTEXT rather than the
        # page: a popup is where a checkout or a sign-in usually lands, and a
        # per-page listener would be blind to exactly the ones worth seeing.
        # Attached here so a Session cannot exist without it.
        self.failed = collections.deque(maxlen=MAX_FAILED_REQUESTS)
        # request -> the origin of the document that asked, oldest first.
        self.asked_by = collections.OrderedDict()
        page.context.on("request", self.note_request)
        page.context.on("response", self.note_response)

    def _forget_navigated(self):
        """A page showing a NEW DOCUMENT is not the page anything was filled on.

        A same-document navigation is not that: the nodes are still there, the
        values are still in them, and the marks still have to go back on.
        """
        try:
            token = self.page.evaluate(DOC_TOKEN_JS)
        except Exception:
            # Mid-navigation, or a page that will not evaluate. Keeping the
            # record is the safe answer: a mask that no longer matches anything
            # is dropped when it fails to resolve, whereas a record thrown away
            # here is a field nobody puts the mark back on.
            return
        if self.seen_document.get(self.page) != token:
            self.seen_document[self.page] = token
            self.masked.pop(self.page, None)

    def remember_masked(self, document_token, selector):
        self.masked.setdefault(self.page, set()).add((document_token, selector))

    def forget_masked(self, document_token, selector):
        """Called when a field is filled with something the vault does not
        conceal: whatever is in it now is not a secret, and re-marking it later
        would hide an address the agent was told to check."""
        targets = self.masked.get(self.page)
        if targets:
            targets.discard((document_token, selector))

    def _frames_by_token(self):
        """Every frame of the active page, by the document it is showing.

        A frame that will not answer is skipped rather than guessed at: it is
        mid-navigation or gone, and either way it is not the document anything
        was filled into.
        """
        found = {}
        for frame in self.page.frames:
            try:
                found.setdefault(frame.evaluate(DOC_TOKEN_JS), frame)
            except Exception:
                continue
        return found

    def reapply_masks(self):
        """Put the mark back on every masked field of the active page.

        Returns the selector of a field that could NOT be masked, or None when
        every one of them is covered. A field whose node has gone is dropped: it
        is not on the page, so it is not on the screenshot either.
        """
        targets = self.masked.get(self.page)
        if not targets:
            return None
        frames = self._frames_by_token()
        for document_token, selector in sorted(targets):
            frame = frames.get(document_token)
            if frame is None:
                # That document is not on this page any more -- the frame was
                # removed, or it navigated, which for a child frame is the same
                # thing said differently. Nothing of it is on screen to hide.
                targets.discard((document_token, selector))
                continue
            try:
                el = frame.query_selector(selector)
            except Exception:
                targets.discard((document_token, selector))
                continue
            if el is None:
                targets.discard((document_token, selector))
                continue
            if el.evaluate(MASK_JS) == "unmasked":
                return selector
        return None

    @property
    def pages(self):
        return self.page.context.pages

    def note_request(self, request):
        """Remember which document asked, at the moment it asked.

        A frame's url is whatever it is showing NOW, so reading it when the
        response arrives lets a page issue a request it knows will fail, move
        itself to an approved origin, and have the refusal read as that origin's
        own trouble. The answer is a snapshot taken before any of that can
        happen. Bounded like everything else here: a page that asks for
        thousands of things is not going to be remembered for all of them, and
        an unremembered request simply names nobody.
        """
        try:
            try:
                frame = request.frame
                if not request.is_navigation_request():
                    origin = _origin(frame.url)
                elif frame.parent_frame is None:
                    # The top frame: the one the agent sees for itself. Marked
                    # here so the answer path never asks about the frame again —
                    # a second read is a second thing that can raise, and there
                    # it would cost the whole entry.
                    origin = None
                else:
                    # A frame's own document load names NOBODY. Playwright does
                    # not say who asked for one, and neither the frame's url nor
                    # its embedder's can stand in: a loaded child can move
                    # itself, an embedder can move a child, and a frame can be
                    # blanked and moved in two steps to look like either. So the
                    # owner keeps these and the agent is told nothing it cannot
                    # be told honestly. What the frame asks for AFTER it loads
                    # is attributable, and is where the diagnosis lives anyway.
                    origin = ""
            except Exception:  # noqa: BLE001 — an unattributable request is still a request
                origin = ""
            # Keyed on the request itself, and holding it: an id alone can be
            # reused by a later object once this one is collected, and the next
            # refusal would then be stamped with a stranger's origin.
            self.asked_by[request] = origin
            while len(self.asked_by) > MAX_REMEMBERED_REQUESTS:
                self.asked_by.popitem(last=False)
        except Exception:  # noqa: BLE001 — a listener that raises takes the page with it
            pass

    def note_response(self, response):
        """Remember a request the site refused.

        Only 4xx/5xx: a sign-in flow is mostly redirects, and keeping those
        would push the one refusal that matters out of a short ring.

        Never a TOP-LEVEL navigation: an agent that goes somewhere and is
        refused SEES that -- the page is right there in its next screenshot. A
        frame's document load is not that; a payment or sign-in iframe coming
        back 403 is exactly the "it said ok and nothing worked" case this is
        for, so it is kept. Which of the two a request was is decided when it is
        MADE -- see note_request, which also decides who asked -- and remembered
        as the initiator being None.

        Nothing here may raise -- this runs on Playwright's event thread, where
        an exception is nobody's to catch -- and nothing here reads a body.
        """
        try:
            # Popped before anything else: a request that came back fine is
            # done, and leaving it in would let completed traffic crowd out a
            # refusal still waiting to be answered.
            request = response.request
            initiator = self.asked_by.pop(request, "")
            if response.status < 400 or initiator is None:
                return
            entry = {
                "status": response.status,
                "method": request.method,
                "origin": _origin(response.url),
                # WHICH document asked. Both ends have to be approved before the
                # device shows an entry to the agent: destination alone lets a
                # page the session is locked out of fetch a url it knows will
                # fail on an approved host and pass that off as the approved
                # page's own trouble. An origin is all this is, so there is
                # nothing here a page can write text into either.
                "initiator": initiator,
            }
            for name in FAILED_REQUEST_HEADERS:
                value = response.headers.get(name)
                if value:
                    entry[name.replace("-", "_")] = str(value)[:100]
            self.failed.append(entry)
        except Exception:  # noqa: BLE001 — a listener that raises takes the page with it
            pass

    def reply_with_failures(self, reply):
        """Add what the page's requests did to a reply, and forget it.

        Every reply an action produces goes through here, a result and an error
        alike, because a refusal that arrives during the action that FAILED is
        the one most worth having and a seam only the success path passes
        through is a seam that loses it. Most recent first, reported once.
        `quit` is deliberately outside it: the device is shutting the browser
        down and discards that reply, so anything still in the ring dies with
        the session it belonged to.
        """
        if self.failed:
            reply["failed_requests"] = list(reversed(self.failed))
            self.failed.clear()
        return reply

    def envelope(self, result):
        """Every response carries where we are, so the client can enforce scope
        and notice popups without extra round-trips."""
        out = dict(result)
        try:
            out["url"] = self.page.url
            out["page_count"] = len(self.pages)
        except Exception:
            out["url"] = ""
            out["page_count"] = 0
        return out

    def holds(self, frame, selector):
        """Does this frame have the selector right now? Instant, never waits."""
        try:
            return frame.query_selector(selector) is not None
        except Exception:  # noqa: BLE001 -- a frame that went away holds nothing
            return False

    def indexed_frames(self, cmd):
        """`frames_for` with each frame's index on the page alongside it."""
        base = int(cmd["frame"]) if "frame" in cmd else 0
        return [(base + n, fr) for n, fr in enumerate(self.frames_for(cmd))]

    def frames_for(self, cmd):
        """Explicit frame index if given, else all frames (login forms hide in iframes)."""
        if "frame" in cmd:
            frames = self.page.frames
            i = int(cmd["frame"])
            if not (0 <= i < len(frames)):
                raise RuntimeError("no frame %d (have %d)" % (i, len(frames)))
            return [frames[i]]
        return self.page.frames

    def _click(self, cmd):
        """One click, inside a budget that covers the whole action.

        A click that names no frame searches all of them, so a per-frame timeout
        would really be N x itself -- past the caps the number was chosen
        against. The way to spend one budget instead is to find the frame first:
        since `query_selector` is instant, waiting for the selector to APPEAR is
        a scan of every frame at once rather than a wait carved up between them
        (which spends each frame's share blind to the others -- an element
        arriving in the first frame a moment after its share ran out was missed
        with most of the budget unspent). Whatever frame holds the selector gets
        what remains, and no frame holding it by the deadline is an honest "not
        found" rather than a timeout.

        The frames scanned are the ones the page had when the command arrived,
        and stay that way: re-reading them would let a frame injected DURING the
        wait be clicked, and the device approved origins for the page it could
        see, not for whatever arrives while it waits (issue #95, which is also
        where that capability comes back once frames carry an approved origin).
        The test holding this down lives in the Camoufox tier -- `just
        test-browser`, not `just test` -- so undoing it goes green in CI.

        A frame the caller NAMED skips the scan entirely and is simply waited in.
        """
        sel = cmd["selector"]
        budget_ms = int(cmd.get("timeout_ms") or DEFAULT_ACTION_TIMEOUT_MS)
        deadline = time.monotonic() + budget_ms / 1000.0
        frames = self.indexed_frames(cmd)
        if "frame" not in cmd:
            while True:
                holding = [(i, fr) for i, fr in frames if self.holds(fr, sel)]
                if holding:
                    frames = holding
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError(
                        "no frame has %s after %dms" % (sel, budget_ms)
                    )
                self.page.wait_for_timeout(SCAN_INTERVAL_MS)

        last = None
        for tried, (i, fr) in enumerate(frames):
            left = int((deadline - time.monotonic()) * 1000 / (len(frames) - tried))
            if left <= 0:
                # The selector IS somewhere -- the scan said so -- but the
                # budget went on waiting for it. Saying "not found" here would
                # be false and would send the agent looking elsewhere when what
                # it needs is more budget; a real failure from a frame that did
                # get tried is better still.
                last = last or RuntimeError(
                    "found %s with no time left to click it" % sel
                )
                break
            try:
                fr.click(sel, timeout=left)
                self.page.wait_for_timeout(SETTLE_MS)
                return {"ok": True, "frame": i}
            except Exception as exc:  # noqa: BLE001 -- re-raised below
                last = exc
        raise last or RuntimeError("selector not found: %s" % sel)

    def _fill(self, cmd):
        """One fill, searching the frames on the per-frame default.

        No budget reaches this: `timeout_ms` is a click's. A credential field is
        found by searching the frames, and shortening the later ones would drop
        fills that work today.
        """
        sel = cmd["selector"]

        last = None
        for i, fr in self.indexed_frames(cmd):
            # ONE resolved node for the whole fill. Resolving the selector a
            # second time is the re-resolution failure the mark exists to avoid:
            # a re-render between the two would leave the attribute on a
            # detached node and put the value into a fresh, unmarked one.
            # Marking through the handle and filling through the SAME handle
            # makes that impossible -- a node that goes away raises here and the
            # value is never typed.
            try:
                el = fr.wait_for_selector(sel, timeout=DEFAULT_ACTION_TIMEOUT_MS)
            except Exception as exc:  # noqa: BLE001 -- sorted out by the asks below
                # Why this frame gave nothing, and Playwright says all three the
                # same way. Simply not having the field is the ordinary case on
                # the way to the frame that does, and says nothing worth
                # carrying. A frame holding the field and refusing to show it is
                # the answer the caller is waiting for, so it always wins. A
                # frame that went away is worth hearing only if nothing better
                # is ever offered -- it must not overwrite the frame that had
                # the field just because it sorts after it.
                if self.holds(fr, sel):
                    last = exc
                elif fr.is_detached() and last is None:
                    last = exc
                continue
            if el is None:
                continue
            # Only the SEARCH may move on to the next frame. Once a node
            # resolves, whatever happens to it is this fill's answer: a failure
            # that had already changed it, swallowed here and retried in the
            # frame below, leaves two fields holding something and reports the
            # success of the second one.
            #
            # The device checked an origin before it went away to fetch the
            # value. If the node it resolved is in a different DOCUMENT than
            # the one it checked, nothing here is what was approved -- so
            # nothing is marked and nothing is typed. The token, not the URL:
            # an SPA rewriting its address bar mid-lookup has not replaced
            # anything, and refusing that is a fill the owner has to do by hand
            # for no reason.
            expected = cmd.get("frame_token")
            if expected is not None and el.evaluate(DOC_TOKEN_JS) != expected:
                return {"ok": False, "mask": "moved", "frame": i}
            # The one thing that can be known before touching the node: the
            # field says how much it holds, and this is more. Refused here so
            # the page is left exactly as it was found -- and refused only on
            # this, because "will it fit" needs no idea what the value MEANS,
            # where "was the field entitled to change it" does.
            kind = el.evaluate(TYPEABLE_JS)
            cap = el.evaluate(FIELD_CAP_JS)
            if cap >= 0 and _arrives_as(cmd["value"], kind) > cap:
                return {"ok": False, "mask": "too_long", "cap": cap, "frame": i}
            if cmd.get("mask"):
                # Marked first, and only typed once the mark is known to have
                # taken. An unmasked answer means the page defeated it, and the
                # value is not typed at all -- the caller turns that into its
                # own refusal. Marking and filling are one step or neither: a
                # mark that goes on and a fill that then times out would leave
                # an ordinary field tagged and withheld from `forms` for the
                # life of the page.
                was_marked = el.evaluate(WAS_MARKED_JS)
                before = el.evaluate_handle(VALUE_SNAPSHOT_JS)
                state = el.evaluate(MASK_JS)
                if state == "unmasked":
                    before.dispose()
                    return {"ok": False, "mask": state, "frame": i}
                try:
                    attempted = _type_value(el, cmd["value"], kind)
                except Exception:
                    # Nothing landed: put the node back as it was found.
                    # Something did: it is holding a value nobody can account
                    # for, so the mark stays and the ledger learns about it.
                    if el.evaluate(NOTHING_LANDED_JS, before):
                        if not was_marked:
                            el.evaluate(UNMASK_JS)
                    else:
                        self.remember_masked(el.evaluate(DOC_TOKEN_JS), sel)
                    raise
                finally:
                    before.dispose()
                self.remember_masked(el.evaluate(DOC_TOKEN_JS), sel)
                return {"ok": True, "mask": state, "frame": i,
                        **_kept(el, attempted)}
            # Not a secret. The mark comes off AFTER the value is in, never
            # before: a fill that times out would otherwise leave the node
            # holding the previous secret with nothing left to hide it.
            attempted = _type_value(el, cmd["value"], kind)
            el.evaluate(UNMASK_JS)
            self.forget_masked(el.evaluate(DOC_TOKEN_JS), sel)
            return {"ok": True, "frame": i, **_kept(el, attempted)}
        raise last or RuntimeError("selector not found: %s" % sel)

    def handle(self, cmd, screenshots_dir):
        action = cmd.get("action", "")
        self._forget_navigated()

        if action in ("screenshot", "forms"):
            # Nothing the agent looks at goes out over a field that should be
            # covered and is not. The mark is re-applied first, and if one of
            # them will not take, the observation does not happen at all --
            # returning the picture anyway is how the value ends up in the
            # transcript, which is the whole thing this exists to stop.
            exposed = self.reapply_masks()
            if exposed is not None:
                return {"ok": False, "mask": "unmasked"}

        if action == "goto":
            # 12s + 1s settle keeps the whole action under the device's 15s host
            # cap and the relay's ~20s exchange ceiling; a genuinely slower page
            # fails cleanly (the agent retries) rather than parking a torn 504.
            self.page.goto(cmd["url"], timeout=12000, wait_until="domcontentloaded")
            self.page.wait_for_timeout(SETTLE_MS)
            return {"title": self.page.title()}

        if action == "pages":
            return {
                "pages": [
                    {"i": i, "url": pg.url, "title": pg.title()} for i, pg in enumerate(self.pages)
                ],
                "active": self.pages.index(self.page),
            }

        if action == "use_page":
            pages = self.pages
            i = int(cmd["index"])
            if not (0 <= i < len(pages)):
                raise RuntimeError("no page %d (have %d)" % (i, len(pages)))
            self.page = pages[i]
            self.page.bring_to_front()
            return {"ok": True, "title": self.page.title()}

        if action == "back":
            # Neither history.back() nor page.go_back() actually moves a tab
            # under Camoufox. Report whether the URL changed rather than lying.
            was = self.page.url
            self.page.go_back(timeout=12000, wait_until="domcontentloaded")
            self.page.wait_for_timeout(SETTLE_MS)
            return {"title": self.page.title(), "moved": self.page.url != was}

        if action == "view":
            # Viewer frame for the owner's monitor window: like screenshot but
            # never touches disk (frames arrive ~1/s; writing them would grow
            # the screenshots dir without bound) and slightly cheaper.
            data = self.page.screenshot(type="jpeg", quality=60, full_page=False)
            return {
                "data_b64": base64.b64encode(data).decode("ascii"),
                "mime": "image/jpeg",
            }

        if action == "screenshot":
            data = self.page.screenshot(type="jpeg", quality=70, full_page=False)
            path = os.path.join(screenshots_dir, "shot-%d.jpg" % int(time.time() * 1000))
            with open(path, "wb") as fh:
                fh.write(data)
            return {
                "data_b64": base64.b64encode(data).decode("ascii"),
                "mime": "image/jpeg",
                "path": path,
            }

        if action == "text":
            limit = int(cmd.get("max", 8000))
            return {"text": self.page.inner_text("body")[:limit]}

        if action == "eval":
            # The one action that hands page values back verbatim. Masking makes
            # a filled secret unreadable to SCREENSHOTS and to `forms`; it
            # cannot reach this, which reads `input.value` directly. Deliberate
            # and documented (DESIGN.md §11a): the threat model is accidental
            # exposure, and an agent going looking with eval is outside it.
            return {"result": self.page.evaluate(cmd["expression"])}

        if action == "click":
            return self._click(cmd)

        if action == "fill":
            return self._fill(cmd)

        if action == "locate":
            # Which frame owns this selector, and what URL is that frame on?
            # The client uses the answer to bind a credential release to the
            # page actually on screen — never to an agent-supplied URL.
            sel = cmd["selector"]
            for i, fr in enumerate(self.page.frames):
                try:
                    el = fr.query_selector(sel)
                except Exception:
                    continue
                if el is not None:
                    # The url is what the device checks an origin against; the
                    # token is what says "still this document" when the value
                    # comes back.
                    return {"frame": i, "frame_url": fr.url, "frame_token": el.evaluate(DOC_TOKEN_JS)}
            raise RuntimeError("selector not found: %s" % sel)

        if action == "scroll":
            d = cmd.get("direction", "down")
            js_map = {
                "down": "window.scrollBy(0,window.innerHeight)",
                "up": "window.scrollBy(0,-window.innerHeight)",
                "bottom": "window.scrollTo(0,document.body.scrollHeight)",
                "top": "window.scrollTo(0,0)",
            }
            self.page.evaluate(js_map.get(d, js_map["down"]))
            self.page.wait_for_timeout(SETTLE_MS)
            return {"ok": True}

        if action == "wait":
            self.page.wait_for_timeout(int(float(cmd.get("seconds", 1)) * 1000))
            return {"ok": True}

        if action == "url":
            return {}

        if action == "title":
            return {"title": self.page.title()}

        if action == "links":
            return {"links": self.page.evaluate(LINKS_JS)}

        if action == "forms":
            fields = []
            for i, fr in enumerate(self.page.frames):
                try:
                    got = fr.evaluate(FIELD_JS)
                except Exception:
                    continue
                for f in got:
                    f["frame"] = i
                    f["frame_url"] = fr.url
                    fields.append(f)
            return {"forms": fields}

        if action == "tables":
            return {"tables": self.page.evaluate(TABLES_JS)}

        raise RuntimeError("unknown action: %s" % action)


def main():
    args = _parse_args()
    os.makedirs(args.screenshots_dir, exist_ok=True)

    from camoufox.sync_api import Camoufox

    # Always present a macOS fingerprint: this device IS a Mac, and the pin is
    # what lets the packaged app drop Camoufox's bundled Windows/Linux spoofing
    # fonts (~360 MB/arch) — a macOS fingerprint renders with the system fonts.
    kwargs = {"headless": not args.headed, "os": "macos"}
    if args.executable:
        kwargs["executable_path"] = args.executable
    if args.profile_dir:
        kwargs["persistent_context"] = True
        kwargs["user_data_dir"] = args.profile_dir

    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))

    with Camoufox(**kwargs) as browser:
        # Camoufox yields a Browser normally, a BrowserContext when persistent.
        # A persistent context is handed over with a page ALREADY open, so
        # calling new_page() there leaves that first one abandoned: the owner
        # watches two windows and cannot tell which is being driven, and
        # anything reading pages[0] drives the wrong one.
        page = browser.pages[0] if args.profile_dir else browser.new_page()
        session = Session(page)

        version = ""
        try:
            version = getattr(browser, "version", "") or getattr(
                getattr(browser, "browser", None), "version", ""
            ) or ""
        except Exception:
            pass
        _respond({"status": "ready", "pid": os.getpid(), "browser_version": version})

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
            except json.JSONDecodeError:
                _respond({"id": None, "error": "invalid JSON"})
                continue

            rid = cmd.get("id")
            if cmd.get("action") == "quit":
                _respond({"id": rid, "result": {"ok": True}})
                break

            try:
                result = session.handle(cmd, args.screenshots_dir)
                reply = {"id": rid, "result": session.envelope(result)}
            except Exception as exc:  # noqa: BLE001 — every failure must answer
                reply = {"id": rid, "error": str(exc)[:MAX_ERROR_LEN]}
            _respond(session.reply_with_failures(reply))
        # EOF on stdin: supervisor died — fall through and let the context close.


if __name__ == "__main__":
    main()
