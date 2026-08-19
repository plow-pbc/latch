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
  `FileOps`, `Executor` (+ generated seatbelt profile), `BlessedToolRegistry`,
  `AuditLog`, `GoalsLibrary`, identity/key store; `src/browser/` is the local
  browsing subsystem (session grants, origin enforcement, credential gate —
  DESIGN.md §11a). `vendor/browser-server/` is the vendored Python
  Camoufox server + 1Password broker (pins in `runtime.lock.json`;
  `just fetch-browser-runtime`/`fetch-browser` build the gitignored runtime;
  tests use fake servers and need no Python).
- `packages/mcp-server` (`@domo/mcp-server`) — the MCP server this Mac serves
  (revision 2026-07-28): the reduced tool surface (including the `browser_*`
  tools), capability construction from tool arguments, and the deferred-result
  contract. Binds no port; takes a `Request`, returns a `Response`.
- `packages/relay-client` (`@domo/relay-client`) — dials the Plow relay, speaks
  plow's channel handshake, and serves the HTTP exchanges it tunnels. `wire.ts`
  is the cross-repo interface.
- `apps/desktop` — the Electron app. Main process runs `device-core`; the
  renderer is sandboxed (see the security rule below).

**Being rebuilt.** The broker (its rendezvous service, MCP subset, stdio shim,
connection-string/pinning concepts and pairing flow) has been removed. A Mac
dials *out* to the Plow relay, which authenticates the calling agent and forwards
MCP to `@domo/mcp-server`. Both halves of this side exist. **The relay itself
does not** — different repository, not built — and the in-repo stand-in that
used to verify this side against the wire contract has been deleted (head
chef's call: a locally running plow API simulates plow). The scripts that drove
a *live* stack went with it, so there is **no automated live-stack path either**
— not here, not in CI. The relay leg is verified **by hand**: bring up a plow
stack, run the app against it, drive it. `packages/relay-client/test` keeps only
the pure wire-contract checks. See [docs/TESTING-THE-APP.md](docs/TESTING-THE-APP.md).

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
- **Nothing may block past the call budget.** The relay advertises its exchange
  deadline at the handshake and abandons the exchange on it, so a tunnelled call
  has to answer with at least the delivery margin to spare — the desktop derives
  its budget from what was advertised and keeps the old, shorter one when a relay
  advertises nothing (`packages/relay-client/src/wire.ts`). Every tool is
  classified: a **deferrable** one returns a deferred handle and keeps working,
  and `get_result` retrieves it; a **direct-bounded** one has no handle to hand
  back and is held to a hard ceiling instead. A handle belongs to the `agent_id`
  that created it. This is why file operations are async and size-capped:
  synchronous work blocks the event loop and the budget timer never fires.
- **`agent_id` is the isolation key; `agent_name` is display-only.** Jobs,
  deferred handles and always-allow rules key on the id. The name is nullable
  and not unique — two credentials can share one — so it identifies nothing.
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
- **`fixtures/` is the frozen protocol spec.** The golden vectors (canonical
  JSON, grant signing bytes, rule keys, SBPL profiles) were generated by the
  original Swift implementation, which has been removed; the fixtures are now the
  source of truth. Any change to canonical encoding, signing bytes, rule keys or
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

**Git worktrees run side by side with main.** After `git worktree add`, run
`./scripts/worktree-setup.sh` in the new checkout: it clones the gitignored browser
runtime from the main checkout (APFS clones, no re-download), then installs and
builds. All per-checkout state is keyed on the normalized branch name
(`scripts/worktree-name.sh --branch`) — for **every** checkout, main included:
one folder per instance, `~/Library/Application Support/Domo-<branch>`, which
holds everything including Electron's userData (`<home>/electron`); the app
name gains a `(<branch>)` suffix on screen. Only the packaged install uses the
unsuffixed `Domo` home, so no from-source run can touch its state. Each
checkout signs in for its own relay credential — never copy
`settings.json` between homes (the relay does not support two devices on one
credential). `just package` refuses to run from a worktree; package from main
(`just package-unnotarized`, the local-check build, runs from any checkout).
