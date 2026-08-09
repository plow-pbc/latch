# CLAUDE.md — working in this repo

Domo lets a remote AI agent use a Mac through an intent-based approval + sandbox
system. Read [DESIGN.md](DESIGN.md) before making structural changes — it records
the decisions and their rationale, and the roadmap.

## Layout

- `Sources/DomoProtocol` — wire types: `JSONValue`/canonical JSON, `KeyPair`
  (Ed25519), `Capability`, `Intent`/`Grant`/`AlwaysAllowRule`, `RuleKey`,
  `PathUtil`. No I/O, no dependencies. Most invariants live here.
- `Sources/DomoTransport` — the transport seam (`Connection`/`ConnectionListener`/
  `ConnectionDialer` in Transport.swift, pinning types in TransportSecurity.swift),
  the Unix-socket implementation, NDJSON framing, and `LineRPC`. Everything above
  `LineRPC` speaks `Connection`, never a concrete socket — so a networked
  transport drops in without touching business logic. The network/security build
  plan lives in `docs/network-security-runbook.md` (execute one phase at a time;
  keep Unix sockets as the default test transport).
- `Sources/DomoBrokerCore` — broker state, routing, `MCPSession` (MCP tools →
  signed intents).
- `Sources/DomoDeviceCore` — `DeviceAgent`, `PolicyEngine`, `FileOps`,
  `Executor` (+ seatbelt profile), `BlessedTools`, `AuditLog`, `GoalsLibrary`.
- `Sources/domo-{broker,device,mcp}` — CLI entry points.
- `Sources/DomoApp` — AppKit shell. **AppKit only — no SwiftUI.**

## Rules of the road

- **Testing is a deliverable.** Every behavior must be reachable by
  `swift test` with no UI and no human. The headless `domo-device` + scripted
  `HeadlessPolicy` exist for this; E2E tests boot real broker + device
  processes. Add tests with new behavior.
- **The audit log is the test oracle.** Assert on `audit.ndjson` events rather
  than internal state where possible. Keep events append-only and one-per-line.
- **Enforcement derives from approved capabilities, never from goal text.**
  Rule keys and sandbox profiles are computed from the capability set; goal text
  is display-only. Don't let goal text influence a decision path.
- **`PathUtil.canonicalize` must return true physical paths** (via `realpath`),
  because seatbelt enforces against physical paths. Do not swap in
  `resolvingSymlinksInPath` — it strips `/private` and silently breaks scoping.
- **Everything honors `DOMO_HOME`** so tests use throwaway roots.
- Unix socket paths are capped ~104 chars; keep test `DOMO_HOME` short.
- `DOMO_DEBUG_SANDBOX=1` dumps generated seatbelt profiles to stderr.

## Build & test

Use `just` (run `just` to list recipes): `just test` (full), `just unit`
(fast), `just e2e` (full-stack), `just demo` (build + local stack + one live
session + audit), `just run <argv>` (drive the stack). Stack lifecycle:
`just up` / `just down` / `just status` / `just clean`. `scripts/session.py` is
the sequential MCP driver behind `demo`/`run`. A `Makefile` mirrors the core
build/test targets.

### The app must be a bundle

`just app` builds `Domo.app` (via `scripts/bundle.sh`) and `open`s it. Never
run the bare `.build/debug/DomoApp` binary for real use — unbundled it has no
Dock presence and won't activate, so it looks like "nothing happens".

`just test-ui` runs `scripts/ui_smoke.sh`: **genuine CGEvent mouse clicks**
(via `scripts/click.swift`) against the running app, asserting real behavior.
Use real clicks, not AX `AXPress`/`select` — those actuate controls even when
real mouse events don't route (e.g. NSTableView needs `acceptsFirstMouse` to
select on a click that also focuses the window). Two bugs slipped past
AX-only testing: table rows not selecting on first-mouse, and the Start Agent
command breaking on the space in "Application Support" (fixed by invoking
claude with an argument array, never a shell string).
