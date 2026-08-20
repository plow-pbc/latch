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

# How many refused requests one reply can carry back, and how long a recorded
# url may be. The relay buffers a whole exchange, so a chatty page must not be
# able to park one; a handful of the most recent is what says "you are blocked".
MAX_FAILED_REQUESTS = 5
MAX_FAILED_REQUEST_URL = 200

# Kept off a refused request beyond status/method/url. Never a body -- a body
# can echo a submitted credential -- and never an arbitrary header: Set-Cookie
# and friends live there. Retry-After says "wait" rather than "you are blocked",
# and its ABSENCE on a 429 is diagnostic in itself; Server usually distinguishes
# an origin rate-limiting us from a bot vendor refusing us.
FAILED_REQUEST_HEADERS = ("retry-after", "server")


def _strip_query(url):
    """Query and fragment carry tokens -- B2C hangs tx=StateProperties= there --
    and userinfo carries a password outright. Stripped where the url is
    recorded, so nothing downstream is holding one."""
    cut = url.split("?", 1)[0].split("#", 1)[0]
    return re.sub(r"^([a-z][a-z0-9+.-]*://)[^/]*@", r"\1", cut, flags=re.I)

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

# Whether a field still holds what it held a moment ago. The previous value
# stays in the page as a handle and is compared there, so it is exact and never
# crosses the wire. A hash was tried and is not good enough: "BB" and "Aa" share
# one, and a partial fill that collided would look unchanged and have its mark
# taken off, which is the one outcome this must never produce.
VALUE_SNAPSHOT_JS = """(el) => el.value || ''"""
VALUE_UNCHANGED_JS = """(el, previous) => (el.value || '') === previous"""

# Whether a node is already carrying the mark, asked before anything touches it.
WAS_MARKED_JS = """(el) => el.hasAttribute("data-domo-secret")"""

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

    def note_response(self, response):
        """Remember a request the site refused.

        Only 4xx/5xx: a sign-in flow is mostly redirects, and keeping those
        would push the one refusal that matters out of a short ring. Nothing
        here may raise -- this runs on Playwright's event thread, where an
        exception is nobody's to catch -- and nothing here reads a body.
        """
        try:
            if response.status < 400:
                return
            headers = response.headers
            entry = {
                "status": response.status,
                "method": response.request.method,
                "url": _strip_query(response.url)[:MAX_FAILED_REQUEST_URL],
            }
            for name in FAILED_REQUEST_HEADERS:
                value = headers.get(name)
                if value:
                    entry[name.replace("-", "_")] = str(value)[:100]
            self.failed.append(entry)
        except Exception:  # noqa: BLE001 — a listener that raises takes the page with it
            pass

    def reply_with_failures(self, reply):
        """Add what the page's requests did to a reply, and forget it.

        Every reply goes through here -- a result, an error, the answer to
        `quit` -- because a refusal that arrives during the action that FAILED
        is the one most worth having, and a seam only the success path passes
        through is a seam that loses it. Most recent first, reported once.
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
            self.page.wait_for_timeout(1000)
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
            self.page.wait_for_timeout(1000)
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

        if action in ("click", "fill"):
            sel = cmd["selector"]
            last = None
            frames = self.indexed_frames(cmd)
            # A click that names no frame searches all of them, so a per-frame
            # timeout would really be N x itself -- past the caps the number was
            # chosen against. Its timeout is the budget for the WHOLE action,
            # and the way to spend it is to find the frame first: since
            # `query_selector` is instant, waiting for the selector to APPEAR is
            # a scan of every frame at once rather than a wait carved up between
            # them (which spends each frame's share blind to the others -- an
            # element arriving in the first frame a moment after its share ran
            # out was missed with most of the budget unspent). Whatever frame
            # holds the selector gets what remains, and no frame holding it by
            # the deadline is an honest "not found" rather than a timeout.
            # The frames scanned are the ones the page had when the command
            # arrived, and stay that way: re-reading them would let a frame
            # injected DURING the wait be clicked, and the device approved
            # origins for the page it could see, not for whatever arrives while
            # it waits (issue #95, which is also where that capability comes
            # back once frames carry an approved origin). The test holding this
            # down lives in the Camoufox tier -- `just test-browser`, not
            # `just test` -- so undoing it goes green in CI.
            # A frame the caller NAMED skips the scan entirely and is simply
            # waited in, which is what the click does anyway. `fill` is outside
            # all of it: no budget reaches it, and it searches the frames on its
            # own per-frame default, because a credential field is found by
            # searching them and shortening the later ones would drop fills that
            # work today.
            if action == "click":
                budget_ms = int(cmd.get("timeout_ms") or DEFAULT_ACTION_TIMEOUT_MS)
                deadline = time.monotonic() + budget_ms / 1000.0
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
            for tried, (i, fr) in enumerate(frames):
                try:
                    if action == "click":
                        left = int(
                            (deadline - time.monotonic()) * 1000 / (len(frames) - tried)
                        )
                        if left <= 0:
                            # Distinct from the not-found above: the selector IS
                            # there, the budget went on waiting for it.
                            last = last or RuntimeError(
                                "found %s with no time left to click it" % sel
                            )
                            break
                        fr.click(sel, timeout=left)
                    else:
                        # ONE resolved node for the whole fill. Resolving the
                        # selector a second time is the re-resolution failure
                        # the mark exists to avoid: a re-render between the two
                        # would leave the attribute on a detached node and put
                        # the value into a fresh, unmarked one. Marking through
                        # the handle and filling through the SAME handle makes
                        # that impossible -- a node that goes away raises here
                        # and the value is never typed.
                        el = fr.wait_for_selector(sel, timeout=DEFAULT_ACTION_TIMEOUT_MS)
                        if el is None:
                            raise RuntimeError("selector not found: %s" % sel)
                        # The device checked an origin before it went away to
                        # fetch the value. If the node it resolved is in a
                        # different DOCUMENT than the one it checked, nothing
                        # here is what was approved -- so nothing is marked and
                        # nothing is typed. The token, not the URL: an SPA
                        # rewriting its address bar mid-lookup has not replaced
                        # anything, and refusing that is a fill the owner has to
                        # do by hand for no reason.
                        expected = cmd.get("frame_token")
                        if expected is not None and el.evaluate(DOC_TOKEN_JS) != expected:
                            return {"ok": False, "mask": "moved", "frame": i}
                        if cmd.get("mask"):
                            # Marked first, and only typed once the mark is
                            # known to have taken. An unmasked answer means the
                            # page defeated it, and the value is not typed at
                            # all -- the caller turns that into its own refusal.
                            # Marking and filling are one step or neither: a
                            # mark that goes on and a fill that then times out
                            # would leave an ordinary field tagged and withheld
                            # from `forms` for the life of the page.
                            was_marked = el.evaluate(WAS_MARKED_JS)
                            before = el.evaluate_handle(VALUE_SNAPSHOT_JS)
                            state = el.evaluate(MASK_JS)
                            if state == "unmasked":
                                before.dispose()
                                return {"ok": False, "mask": state, "frame": i}
                            try:
                                el.fill(cmd["value"], timeout=DEFAULT_ACTION_TIMEOUT_MS)
                            except Exception:
                                # Nothing landed: put the node back as it was
                                # found. Something did: it is holding a value
                                # nobody can account for, so the mark stays and
                                # the ledger learns about it.
                                if el.evaluate(VALUE_UNCHANGED_JS, before):
                                    if not was_marked:
                                        el.evaluate(UNMASK_JS)
                                else:
                                    self.remember_masked(el.evaluate(DOC_TOKEN_JS), sel)
                                raise
                            finally:
                                before.dispose()
                            self.remember_masked(el.evaluate(DOC_TOKEN_JS), sel)
                            return {"ok": True, "mask": state, "frame": i}
                        # Not a secret. The mark comes off AFTER the value is
                        # in, never before: a fill that times out would
                        # otherwise leave the node holding the previous
                        # secret with nothing left to hide it.
                        el.fill(cmd["value"], timeout=DEFAULT_ACTION_TIMEOUT_MS)
                        el.evaluate(UNMASK_JS)
                        self.forget_masked(el.evaluate(DOC_TOKEN_JS), sel)
                    if action == "click":
                        self.page.wait_for_timeout(1000)
                    return {"ok": True, "frame": i}
                except Exception as exc:
                    last = exc
            raise last or RuntimeError("selector not found: %s" % sel)

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
            self.page.wait_for_timeout(1000)
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
