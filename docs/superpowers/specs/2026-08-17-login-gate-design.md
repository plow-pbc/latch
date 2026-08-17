# Login gate + Connect-a-client split — design

Date: 2026-08-17
Product stage: user-facing, shipping today. Polish (pixel-matching the designer
mock, deep-link buttons) is explicitly deferred; correctness of the gate and of
credential handling is not.

## 1. Problem

Login and client-credential creation are conflated in one onboarding wizard,
and login gates nothing: the main window opens regardless, with a non-blocking
setup window floating beside it. Product intent: **if this Mac is not signed in
to the Plow relay, the app is not usable.** Separately, connecting an MCP
client (Claude Code, ChatGPT, headless servers) is per-client, repeatable and
optional — it does not belong inside a one-time login wizard.

## 2. Target design

### 2.1 The gate

On launch, if `settings.relayCredential` is blank, the setup window is the
**only** window — the main window is not created. The onboarding wizard runs
its existing activate → waiting → phone → code path and now **ends at
`connected`**: a brief "This Mac is connected" confirmation whose single
button closes the setup window and opens the main window. The `agent` step
leaves the wizard entirely (see 2.2).

Sign-out reverses the gate: blank the relay fields (existing behavior), close
the main window, open the setup window. Quit-from-gate quits the app. The
tray remains available in both states.

### 2.2 Connect a client (main window)

A first-class nav item "Connect a client" in the main window (peer of
Settings, not buried inside it), carrying the designer's screens 2–4:

- "This Mac is connected" status line.
- Step 1: the MCP server URL (`settings.mcpUrl`) with a Copy button.
- Step 2/3 copy: paste into your client; OAuth is the recommended sign-in —
  visiting the URL walks the client through OAuth; no token to copy or store.
- Fallback link: "Can't use OAuth? Create a static credential" → name the
  connection → mint via the existing `POST /v1/relay/agents` (device
  credential) → copy-once config block → "I've saved it" drops it from
  memory. This is the existing `agent`-step logic relocated, not new API work.

### 2.3 Out of scope

- Any plow API / relay-side change. The seven existing HTTP calls are the
  complete surface.
- OAuth implementation — it lives on the relay and already works by visiting
  the MCP URL; this app only describes it.
- Pixel-perfect match to the mock; ChatGPT/Claude deep-link buttons.

## 3. Verification approach

Everything reachable headless: vitest for state/orchestration, and the
existing offscreen drivers (`scripts/first-run-drive.mjs`,
`scripts/onboarding-screenshot.mjs`) extended to capture the gate, the
connected confirmation, and the Connect-a-client screen. Screenshots are a
deliverable of every chunk — the head chef reviews them as work lands.

## Chunks

### Global Constraints

- No plow API changes: only the existing calls in `apps/desktop/src/plowApi.ts`.
- Credentials never appear in a URL, log line, error string, renderer-visible
  state, or screenshot fixture. `settings:getRelay` keeps returning
  `hasCredential`, never the credential.
- Renderer security posture is unchanged: sandboxed renderer, contextBridge
  only, agent-controlled strings via `textContent`, CommonJS preload.
- `onboarding.ts` stays a pure, Electron-free state machine; window
  orchestration lives in `main.ts`. Presentation logic that can be pure stays
  outside the Electron entry.
- Tests are a deliverable (`npx vitest run`, no UI, no human); mutation-check
  new tests (break the guarded thing, watch the test fail, restore). Assert on
  observable behavior, not internals.
- Everything honors `DOMO_HOME`; keep test homes short.
- Product stage: user-facing, shipping today — review to a Critical/Important
  bar; pixel polish is deferred, credential handling is not.

### Chunk 1: The login gate

Implements: §2.1 of this spec
Interfaces: consumes existing `OnboardingState` + `settings.relayCredential`;
produces the window-orchestration contract (no main window without a
credential; wizard terminal step is `connected`; sign-out returns to the gate)
that Chunk 2's main-window UI assumes.
Done when: vitest green including new orchestration tests, and the offscreen
driver shows (a) fresh `DOMO_HOME` → setup window only, (b) credential present
→ main window only (setup closed), (c) sign-out → back to (a). PNG screenshots
of the gate and the connected confirmation saved and paths reported.

### Chunk 2: Connect a client in the main window

Implements: §2.2 of this spec
Interfaces: consumes Chunk 1's contract and the existing agent-mint logic
(`agentConfig()`, `POST /v1/relay/agents`); produces the Connect-a-client nav
section; removes the `agent` step from the wizard.
Done when: vitest green including tests for the relocated mint flow
(copy-once semantics: config unavailable after "I've saved it"), and an
offscreen PNG of the Connect-a-client screen (URL populated from a test
`DOMO_HOME`, no real credential) saved and path reported.

### Chunk 3: End-to-end pass + screenshot set

Implements: §3 of this spec
Interfaces: consumes the finished app from Chunks 1–2.
Done when: full `just test` output green; a scripted first-run walk
(activate → connected → main window → Connect a client → static credential
copy-once) against the stand-in relay passes; a complete labeled screenshot
set of every screen in the new flow saved and paths reported.
