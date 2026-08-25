# CLAUDE.md — working in this repo

Domo lets a remote AI agent use a Mac through an intent-based approval + sandbox
system. Read [DESIGN.md](DESIGN.md) before making structural changes — it records
the decisions and their rationale, and the roadmap. The stack is **TypeScript**
(Node + Electron); [README-ts.md](README-ts.md) has the layout at a glance.

## Layout

npm workspaces. Libraries in `packages/`, executables/apps in `apps/`:

- `packages/protocol` (`@domo/protocol`) — wire types: `JSONValue`/canonical
  JSON, Ed25519 `KeyPair`, `Capability`, `Intent`/`Grant`/`AlwaysAllowRule`,
  `RuleKey`, `PathUtil`. Pure, no I/O. Most invariants live here.
- `packages/transport` (`@domo/transport`) — the transport seam
  (`Connection`/`ConnectionDialer`) and the WebSocket (`ws`) **client** half.
  This Mac only ever dials out, so there is no listener.
- `packages/device-core` (`@domo/device-core`) — `DeviceAgent`, `PolicyEngine`,
  `FileOps`, `Executor` (+ generated seatbelt profile), `SkillRegistry`,
  `AuditLog`, identity/key store; `src/browser/` is the local
  browsing subsystem (session grants, origin enforcement, credential gate —
  DESIGN.md §11a). `vendor/browser-server/` is the vendored Python
  Camoufox server + 1Password broker (pins in `runtime.lock.json`;
  `just fetch-browser-runtime`/`fetch-browser` build the gitignored runtime;
  tests use fake servers and need no Python).
- `packages/mcp-server` (`@domo/mcp-server`) — the MCP server this Mac serves
  (revision 2026-07-28): the reduced tool surface (including the `plow_browser_*`
  tools), capability construction from tool arguments, and the deferred-result
  contract. Binds no port; takes a `Request`, returns a `Response`.
- `packages/relay-client` (`@domo/relay-client`) — dials the Plow relay, speaks
  plow's channel handshake, and serves the HTTP exchanges it tunnels. `wire.ts`
  is the cross-repo interface.
- `apps/desktop` — the Electron app. Main process runs `device-core`; the
  renderer is sandboxed (see the security rule below).

**Rebuilt: a Mac dials out.** The broker (its rendezvous service, MCP subset,
stdio shim, connection-string/pinning concepts and pairing flow) has been
removed. A Mac dials *out* to the Plow relay, which authenticates the calling
agent and forwards MCP to `@domo/mcp-server`. Both halves of this side exist,
and **so does the relay** — in the `plow-pbc/plow` repository, where
`api/plow/relay/` serves the MCP endpoint, the device WebSocket and an OAuth
flow, covered by `api/tests/relay/`. **Agents reach Macs through this app
today.** This line used to say the relay was "not built", which was true when
written and cost a later reader a wrong assumption; check that repo rather than
this sentence. What is gone is the in-repo stand-in that used to verify this
side against the wire contract (head chef's call: a locally running plow API
simulates plow). The scripts that drove a *live* stack went with it, so there
is **no automated live-stack path** — not here, not in CI. What is manual is
the leg against a REAL relay: bring up a plow stack, run the app against it,
drive it. `packages/relay-client/test` does cover the client's protocol
behavior — the pure wire contract, plus the connection lifecycle over
hand-written fakes; nothing in it opens a socket or tunnels an MCP call. See
[README-ts.md](README-ts.md#integration-coverage) § Integration coverage, which
owns that list.

- **A credential never goes in a URL, a log line, an error string, or the audit
  log.** Two transports carry it, and no third kind: the relay socket's
  post-challenge `auth` frame, and the `Authorization` header of an
  authenticated Plow API call — today agent creation and reviewer inference,
  and anything else added the same way. **A response that repeats it back never
  becomes a verdict, an audit record, or anything the renderer is shown — in any
  encoding.** That is the guarantee; the means is a check on the decoded
  `reason` after the single parse. Describe the guarantee here and leave the
  mechanism to the code — naming the mechanism of the day is how this line goes
  stale. `settings.json` holds it and is
  written `0600`; the renderer is never given it.

- **Capabilities are built on this Mac, from tool arguments.** An agent never
  sends a capability set or an intent — it calls a tool, and `mcp-server`
  derives the capabilities the policy engine and the sandbox will enforce. Goal
  text rides along for the human to read and never influences the bound.
- **Nothing may block past the call budget.** `RELAY_TIMEOUT_MS` in
  `@domo/relay-client`'s `wire.ts` is the relay's ceiling — it belongs with the
  rest of the cross-repo contract — and `CALL_BUDGET_MS` in `@domo/mcp-server`
  is what this Mac allows itself inside it. Any tool that cannot answer in the
  budget returns a deferred handle and keeps working; `plow_get_result`
  retrieves it. A handle belongs to the `agent_id` that created it. This is why
  file operations are async and size-capped: synchronous work blocks the event
  loop and the budget timer never fires.
- **`agent_id` is the isolation key; `agent_name` is display-only.** Jobs,
  deferred handles and always-allow rules key on the id. The name is nullable
  and not unique — two credentials can share one — so it identifies nothing.
  Browser sessions are the exception, and deliberately: several of the owner's
  agents reach this Mac through ONE credential, so keying a session on the id
  made two of them one browser. A session keys on its unguessable handle, and
  the Mac is one person's — every browser on it is theirs.
- **Resolve a path before the human sees it.** The approval dialog's whole value
  is that the human sees what will actually happen, so a supplied path is
  canonicalised before it becomes a capability — never after.
- **No SSE on either leg.** `subscriptions/listen` is refused outright; the
  relay buffers one HTTP exchange per frame and cannot carry a stream.

## Rules of the road

- **Testing is a deliverable.** Every behavior that *can* be reached by
  `npx vitest run` with no UI and no human must be. The scripted `HeadlessPolicy`
  exists for this. Add tests with new behavior. Mocking is function- and
  fixture-level only — a test that stands a server up is the kind that was just
  removed, so anything needing one is a manual run instead.
- **Never launch the app on this Mac.** Windows flash on the head chef's screen.
  Electron runs — the app, the screenshot scripts, `verify-preload` — happen on
  the M4:
  `/Users/plucas/.claude-kitchen/projects/domo-desktop/wiki/m4-screenshots.md`.
- **The audit log is the test oracle.** Assert on `audit.ndjson` events rather
  than internal state where possible. Keep events append-only and one-per-line.
- **`fixtures/` is the frozen protocol spec.** The golden vectors were
  generated by the original Swift implementation, which has been removed; the
  fixtures are now the source of truth. `README-ts.md` lists which six they are
  and how each is asserted. Any change to canonical encoding, signing bytes, rule keys or
  SBPL that changes these bytes is a protocol break — update the fixtures
  deliberately and say so. `connection.json`, `channel.json` and `challenge.json`
  were deleted with the concepts they froze, and `intent.json` was re-frozen
  without `agentPublicKey`/`signature`; those were declared protocol breaks.
- **Enforcement derives from approved capabilities, never from goal text.**
  Rule keys and sandbox profiles are computed from the capability set; goal text
  is display-only. Don't let goal text influence a decision path.
- **`canonicalize` must return true physical paths** (via `fs.realpathSync`),
  because seatbelt enforces against physical paths. `fs.realpathSync` is
  `realpath(3)` and preserves `/private` — don't swap in anything that
  normalizes differently.
- **Everything honors `DOMO_HOME`** so tests use throwaway roots.
- `DOMO_DEBUG_SANDBOX=1` dumps generated seatbelt profiles to stderr.
- **Canonical JSON is signature-critical.** Object keys sort by code unit (ASCII
  only — never introduce non-ASCII keys), slashes are not escaped, integral
  numbers print without a decimal point, dates are ISO-8601 strings. The encoder
  in `packages/protocol/src/json.ts` is asserted against `fixtures/`.

## The Electron app

- **Security posture (DESIGN.md §13.2):** every window has `contextIsolation`
  on, `nodeIntegration` off, `sandbox` on, and a strict CSP; no remote content
  is ever loaded. The renderer reaches the main process only through the narrow
  `contextBridge` API in `preload.cts`.
- The **approval window renders only from the verified canonical intent's view
  model** (`viewModel.ts`); agent-controlled strings are inserted as
  `textContent`, never HTML, and the enforceable bound shown is the capability
  set, not the goal text.
- The preload MUST be CommonJS (`preload.cts` → `preload.cjs`) — a sandboxed
  renderer won't load an ESM preload, and `window.domo` silently ends up
  undefined.
- Renderer assets (`src/renderer/*.html|css|js`) are plain files copied to
  `dist/renderer` by `scripts/copy-renderer.mjs` (tsc doesn't emit them).
- Presentation logic that can be pure (`viewModel.ts`, `spawnAgent.ts`) lives
  outside the Electron entry so it's unit-testable without a display.

## Build & test

Use `just` (run `just` to list recipes):

- `just install` — install workspace deps.
- `just build` — `tsc -b` across all packages/apps + copy renderer assets.
- `just test` — the suite; `just test-vectors` for just the fast conformance
  checks.
- `just app` — launch the desktop app. `just verify-preload` is the headless
  check that the sandboxed preload bridge and the renderer still render.

**Checkouts run side by side with main.** In any second checkout — a linked
worktree or a plain clone beside the others — run `./scripts/worktree-setup.sh`
to clone the gitignored browser runtime from a checkout that already has one
(APFS clones, no re-download), then install and build. A linked worktree
inherits its donor from the checkout it was made out of; **a plain clone is
given one**: `./scripts/worktree-setup.sh ~/Hacking/domo-desktop4`. Run with no
argument it lists the candidates it can see, and `--no-donor` sets up without
one. It will not pick one for you: a donor's payloads are executed here, outside
the seatbelt and within reach of this checkout's vault and relay credential, so
anything able to write one checkout could otherwise put code in the next.
`scripts/runtime-donor.sh` owns that reasoning. What it does **not** decide is
whether the copy is any good — the donor is a cache seed, and setup runs
`just fetch-browser` over any payload that arrived — the download cache alone
does not count — once it has installed and built, so
a stale or half-built payload costs a rebuild rather than a refusal, and a
failed fetch leaves a working checkout rather than aborting one.

Without that runtime there is no browser and no vault, and the app says so at
startup rather than leaving the Vault tab to report a vault that has not
started. All state is keyed on the
normalized **branch** name (`scripts/worktree-name.sh --branch`) — for every
checkout, main included: `~/Library/Application Support/Plow-Latch-<branch>`,
holding everything including Electron's userData (`<home>/electron`); the app
name gains a `(<branch>)` suffix on screen. Only the packaged install uses the
unsuffixed `Plow-Latch` home, so no from-source run can touch its state.

The key is the branch, not the checkout, and git only enforces those to be the
same thing for linked worktrees — a branch cannot be checked out in two of
them. **Two plain clones on one branch therefore share a home**: one relay
credential, one device identity, one audit log, one browser profile, and the
relay does not support two devices on one credential. Give one of them its own
`DOMO_HOME` (or put them on different branches) before running both. Never copy
`settings.json` between homes. `just package` refuses to run from a worktree; package from main
(`just package-unnotarized`, the local-check build, runs from any checkout).
