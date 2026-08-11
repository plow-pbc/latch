# Provenance

Adapted from **`plow-pbc/camoufox-cli`** (private, MIT, copyright plow-pbc — same
org as this repo) at commit `6d6da2aeb58a31875ec49adc76847155be107e0b`. The
`LICENSE` here is upstream's and covers this directory.

## What is upstream and what is ours

- **`seed_op_broker/`** — vendored **unmodified** from upstream's
  `broker/src/seed_op_broker/`. (Upstream itself vendored it from
  `plow-pbc/seed-browser-usage` with substantial changes; see the provenance
  notes in upstream's `broker/README.md`.) Domo sets `SEED_OP_AUDIT` to
  `$DOMO_HOME/device/browser/op-audit.log` at spawn time — an env override the
  code already supports, not a code change.
- **`server.py`** — rewritten from the socket server embedded in upstream's
  `scripts/camoufox_cli.py` (`cmd_open`). Behavior kept: the action set
  (frames-aware `click`/`fill`, `forms` with labels, `links`, `tables`,
  `pages`/`use_page`, honest `back` reporting `moved`), timeouts, and the
  field/links/tables JS extractors. Changed:
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

Upstream's `SKILL.md` is *not* vendored: it documents a shell CLI surface. Its
Domo replacement is the built-in `camoufox-browsing` skill in
`packages/device-core`, rewritten for the `browser_*` MCP tools.

## Version coupling (do not bump independently)

`camoufox==0.5.4` ↔ `playwright==1.60.0` ↔ browser `official/152.0.4-beta.28`
(see `runtime.lock.json`). Upstream's README: mismatches crash rather than
degrade.
