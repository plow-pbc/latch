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
import json
import os
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

FIELD_JS = """() => Array.from(document.querySelectorAll("input,select,textarea")).slice(0,40).map(el => {
    let lab = "";
    if (el.labels && el.labels[0]) lab = el.labels[0].textContent.trim();
    if (!lab) lab = el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
    return {
      tag: el.tagName.toLowerCase(), type: el.type || "", name: el.name || "",
      id: el.id || "", label: lab,
      placeholder: el.getAttribute("placeholder") || "",
      maxlength: el.getAttribute("maxlength") || "",
      options: el.tagName === "SELECT"
        ? Array.from(el.options).map(o => o.value).filter(Boolean).slice(0, 40) : [],
      value: (el.value || "").substring(0, 50)
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
    """One live browser + the currently active page."""

    def __init__(self, page):
        self.page = page

    @property
    def pages(self):
        return self.page.context.pages

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
            return {"result": self.page.evaluate(cmd["expression"])}

        if action in ("click", "fill"):
            sel = cmd["selector"]
            last = None
            for i, fr in enumerate(self.page.frames):
                if "frame" in cmd and i != int(cmd["frame"]):
                    continue
                try:
                    if action == "click":
                        fr.click(sel, timeout=3000)
                    else:
                        fr.fill(sel, cmd["value"], timeout=3000)
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
                    if fr.query_selector(sel) is not None:
                        return {"frame": i, "frame_url": fr.url}
                except Exception:
                    continue
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
        # anything reading pages[0] drives the wrong one. Take the page that is
        # already there; only make one when there is none (the Browser case).
        existing = list(getattr(browser, "pages", None) or ())
        page = existing[0] if existing else browser.new_page()
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
                _respond({"id": rid, "result": session.envelope(result)})
            except Exception as exc:  # noqa: BLE001 — every failure must answer
                _respond({"id": rid, "error": str(exc)[:MAX_ERROR_LEN]})
        # EOF on stdin: supervisor died — fall through and let the context close.


if __name__ == "__main__":
    main()
