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
  - A fill TYPES its value — select-all, then a real key event per character
    (`_type_into`) — where upstream assigns `.value` through `fill()`. A field
    that goes from empty to complete having received no keydown is the cheapest
    bot tell there is, and it is what blocked a Costco sign-in behind Kasada.
    Cadence is `TYPING_DELAY_MS`, and the chord plus the keystrokes share one
    deadline, so a fill costs at most `DEFAULT_ACTION_TIMEOUT_MS +
    TYPING_BUDGET_MS`. A value that cannot be carried faithfully as keystrokes
    is assigned exactly as upstream assigns it: an empty one (a clear has no
    keystrokes, and still has to empty the field), one past `MAX_TYPED_CHARS`,
    one holding a newline or a tab (`type()` sends those as Enter and Tab —
    submitting the form, or moving focus so the rest of a secret lands in the
    next field), and any node `TYPEABLE_JS` says no to. That last is every node
    `fill()` treats specially, and every node that is not a text host. Typed:
    the text-carrying `<input>` types, a `<textarea>`, and an element that
    CARRIES `contenteditable` itself. Assigned: a checkbox, a radio, a file
    picker, a submit button, a hidden input, a date input, a `<select>` — where
    `fill()`'s loud refusal or its value-setting lives — and everything that
    merely sits inside a rich-text region, since `isContentEditable` is
    inherited and `type()` would send a secret's characters into an embedded
    document, an option chosen by type-ahead, or wherever focus already was.
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
