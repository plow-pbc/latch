# Provenance

Adapted from **`plow-pbc/camoufox-cli`** (private, MIT, copyright plow-pbc — same
org as this repo) at commit `6d6da2aeb58a31875ec49adc76847155be107e0b`. The
`LICENSE` here is upstream's and covers this directory.

## What is upstream and what is ours

- **`seed_vault_broker/`** — vendored **unmodified** from upstream's
  `broker/src/seed_vault_broker/` at commit
  `38fc7576e758e29d5d33fc2a915e386eea7b3fd5`. (Upstream itself vendored its
  1Password ancestor from `plow-pbc/seed-browser-usage` with substantial
  changes; see the provenance notes in upstream's `broker/README.md`.) Domo
  sets `SEED_VAULT_AUDIT` to `$DOMO_HOME/device/browser/credential-audit.log`
  and `SEED_VAULT_BW` to the bundled CLI at spawn time — env overrides the code
  already supports, not code changes. Its only dependency, `tldextract`, is
  already in `requirements.txt` for the browser server.
- **`server.py`** — rewritten from the socket server embedded in upstream's
  `scripts/camoufox_cli.py` (`cmd_open`). Behavior kept: the action set
  (frames-aware `click`/`fill`, `forms` with labels, `links`, `tables`,
  `pages`/`use_page`, honest `back` reporting `moved`) and the
  field/links/tables JS extractors. Changed:
  - `goto`/`back` page-load timeout cut from 30 s to 12 s (+1 s settle) so a
    single action answers inside Domo's 15 s host cap and the relay's ~20 s
    per-exchange ceiling; a genuinely slower page fails cleanly and the agent
    retries rather than parking a torn 504.
  - Element actions default to a 3 s timeout (`DEFAULT_ACTION_TIMEOUT_MS`) for
    the same budget. `click` takes a caller-supplied `timeout_ms`, bounding the
    WHOLE action rather than each frame the loop tries — the device clamps it to
    11 s (a second under the `wait` ceiling, for the 1 s post-click settle) so N
    frames still answer inside the caps. It exists so a click on a page that is
    still settling has an answer other than `eval`, whose synthesized clicks
    carry `isTrusted: false` and are what gets a session flagged.
  - Started directly by the Domo device supervisor — no CLI, no `os.fork`, no
    fixed 4 s sleep, no `.state.json`, no Unix socket.
  - JSON lines over **stdio** with request ids; original stdout is dup'ed as
    the protocol channel and fd 1 redirected to stderr so browser noise cannot
    corrupt it.
  - `{"status": "ready"}` emitted only after the browser is actually up.
  - `screenshot` returns base64 JPEG (and writes a file); every response
    carries the current `url` + `page_count`; new `locate` action and `frame`
    param on `click`/`fill` (credential fills are bound to the frame actually
    on screen).
  - `--executable` uses camoufox's `executable_path` so the browser ships in
    our app payload and the shared `~/Library/Caches/camoufox` is never used.
  - SIGTERM, `quit`, and stdin EOF all close the Camoufox context cleanly.
  - Context-level `request` + `response` listeners keep the last five 4xx/5xx
    the pages saw, for everything a page asked for on its own account (a
    top-level navigation is dropped — the agent sees that one for itself).
    Each keeps status, method, the origin that refused and the origin that
    asked, read when the REQUEST was made, plus `Retry-After` and `Server`;
    every reply an action produces drains them as `failed_requests`, an error
    as much as a result. Upstream reports nothing about a page's own traffic,
    so an action whose XHR came back 429 answered `{ok: true}`.
  - `fill` types the value in rather than assigning it: everything before the
    last `TYPED_CHARS` is assigned, and the tail arrives as one key event per
    character. Upstream's `el.fill()` sets `.value` and fires a single `input`,
    so a password box goes from empty to complete with no keydown/keypress/keyup
    at all, which is what interrogation-style bot defenses (Kasada, Akamai Bot
    Manager) sample — Costco's sign-in answered every credential submit with a
    429 (issue #86). The split keeps a long value inside the relay budget.
  - **`humanize` is deliberately NOT passed, and the pointer still teleports.**
    This is the other half of #86 and it does not have a fix here. Camoufox's
    humanized cursor hangs this browser build (`official/152.0.4-beta.28`,
    `camoufox==0.5.4`): `page.mouse.move` never returns when the walk is short
    and near the top-left of the viewport — clicking an element in that corner
    hangs, headed and headless alike, and there is no timeout on a mouse
    operation to bound it. `frame.click(selector)` is worse still: with the
    humanized cursor on it never dispatches a click AT ALL, at any geometry,
    because Playwright's hit-target interceptor and the moving pointer deadlock
    (verified out to 40 s). A cursor path is worth having and this is the wrong
    build to get it from; the fix lives in `runtime.lock.json`, not here.
  - Fingerprint OS pinned to `macos` (upstream lets Camoufox pick randomly
    among macos/windows/linux). The device is a Mac, so this is the honest
    fingerprint — and it's what lets the packaged app drop Camoufox's bundled
    Windows/Linux spoofing fonts (`scripts/build-browser-runtime.mjs` strips
    `Contents/Resources/fonts`, ~360 MB per arch); macOS fingerprints render
    with the system fonts.

Upstream's `SKILL.md` is *not* vendored: it documents a shell CLI surface. Its
Domo replacement is the built-in `camoufox-browsing` skill in
`packages/device-core`, rewritten for the `browser_*` MCP tools.

## Version coupling (do not bump independently)

`camoufox==0.5.4` ↔ `playwright==1.60.0` ↔ browser `official/152.0.4-beta.28`
(see `runtime.lock.json`). Upstream's README: mismatches crash rather than
degrade.
