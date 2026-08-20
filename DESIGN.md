# Domo — Design Document

**Status:** v1 (local loop) — decisions locked 2026-08-08
**Audience:** Domo developers and agents working on this codebase.

Domo lets a remote AI agent (Claude Code or any MCP-speaking agent) use a person's
Mac — read and write files, run CLI commands with streaming output, and drive a
real browser on their machine — through an **intent-based request
system**: every operation is a structured, signed intent that a human (later, an
adversarial reviewer agent plus a human escalation path) can inspect and approve
before it executes inside an on-the-fly sandbox derived from exactly the approved
capabilities.

v1 runs entirely on one Mac, but every flow — enrollment, discovery, access
requests, intents, approvals, revocation — goes through the same protocol a
remote deployment will use. Moving to remote means relocating one process, not
redesigning.

---

## 1. Principals

| Principal | v1 form | Future form |
|---|---|---|
| **Device app** (`Domo.app` / `domo-device`) | AppKit app or headless runner on the Mac | Same |
| **Agent** | Claude Code connecting over MCP | Any provisioned agent, possibly remote |
| **Broker / registration service** (`domo-broker`) | Local daemon | Cloud service run by the provisioner |

- The **device app** is the only principal that touches the OS. It owns the
  approval UI, the policy engine (always-allow rules), the executor + sandbox,
  the audit log, and the blessed-tools registry.
- The **agent** never gets raw OS access. It sees an MCP tool surface; every
  call becomes an intent evaluated on the device.
- The **broker** tracks which devices exist and are online, holds agent
  identities/grants, routes messages, and hosts the MCP endpoint. It is
  *not* trusted with OS access and (in the remote milestone) not trusted with
  plaintext traffic.

## 2. Connection model

**Transport direction and authorization direction are independent.**

- **Transport:** the Mac always dials *out* to the broker and holds a
  persistent connection (Unix socket locally; WebSocket/TLS remotely). No
  listening ports on the Mac; NAT/firewall-proof.
- **Authorization:** agent-initiated. Any agent may, at any time, call
  `request_device_access(device, goals)`. The request is routed down the Mac's
  existing connection and the **device owner** decides. Enrollment only makes a
  Mac *findable*; it grants nothing.

### Flows

1. **Enrollment** (once per Mac): device generates an Ed25519 identity
   (Keychain/Secure Enclave in the app milestone; file-backed in headless/dev),
   registers `{device_id, name, public_key, blessed_tools}` with the broker,
   and keeps the connection open.
2. **Access request** (any time): agent calls `request_device_access`. Owner
   sees agent display name + stated goals → allow / deny. Allow records a grant
   `(agent_id → device_id)` at the broker and pins the agent's public key on
   the device.
3. **Mac-initiated spin-up**: the app's **Goals Library** (premade + user
   goals) has "Start agent": the device asks the broker to mint an agent
   identity with a pre-approved grant for *this* device (the user launching it
   is the approval), then launches Claude Code locally with the goal as its
   prompt and an MCP config pointing at the broker. That agent can still
   `request_device_access` to other Macs.

## 3. Agent-facing protocol: MCP

**Superseded.** This section described one MCP endpoint (the broker) serving
device-addressed tools, so that an agent connected once and reached every Mac it
held grants for. There is no broker: a Mac dials the Plow relay and serves its
own tools, addressed by its own URL, so no tool takes a `device` argument and
there is nothing to enumerate. The table that stood here listed
`list_devices`, `request_device_access` and `device`-first signatures for
tools that have since been renamed — it was a second, hand-maintained copy of a
contract that lives in code, and it drifted, as the second copy always does.
**The current surface is in [README-ts.md](README-ts.md); `TOOLS` in
`packages/mcp-server/src/tools.ts` is authoritative.**

Design points:

- **Blessed tools are gone (cut 2026-08-17).** They were per-device tools
  discovered dynamically rather than flattened into the global MCP tool list,
  because different Macs had different tools and devices came and went
  mid-session. That was a *fleet* argument, and it died with the broker: one Mac
  addressed by its own URL has one tool list. The registry never shipped
  anything but a single demo tool (`mac_info`), and nothing but a rebuild could
  add to it — while the same job is one `plow_run_command` away. The capability
  kind `tool` survives in the protocol because it is frozen into
  `fixtures/rulekeys.json`; nothing on this Mac constructs one any more.
- **Skills are the surviving discovery surface.** `plow_list_skills` names what
  this Mac publishes and `plow_read_skill` fetches the body, so a long operator
  manual (`camoufox-browsing`) costs no manifest tokens until an agent asks.
- **Streaming:** MCP tool calls are request/response, so `plow_run_command`
  waits up to `wait_ms` (default 10 s); if the command is still running it
  returns a `handle` plus output-so-far, and the agent polls `plow_get_output`
  for incremental bytes. stdout and stderr are merged into one stream.
- **`goal`:** each mutating tool accepts an optional goal/justification string,
  displayed to the approver. Session-level goals (from the access request or
  spin-up) become the intent's `plan_context`.
- **Network default:** `run_command` denies network unless `network: true` was
  explicitly declared (and therefore approved).

## 4. The intent object

Every operation (file read/write, command, browser session) becomes one signed
intent — the single artifact that the approval UI renders, the sandbox is
derived from, the audit log stores, and the future adversarial reviewer
evaluates.

```json
{
  "intentId": "uuid",
  "agentId": "fingerprint", "agentDisplay": "Family Coordinator",
  "agentPublicKey": "base64-ed25519",
  "deviceId": "target-device",
  "goal": "Resize last month's photos for the shared album",
  "planContext": "Session goals from access request / spin-up",
  "request": "run: sips -Z 1600 ...",
  "capabilities": [
    { "kind": "fs.read",      "paths": ["/Users/x/Pictures/Export"], "reason": "source images" },
    { "kind": "fs.write",     "paths": ["/Users/x/Pictures/Resized"], "reason": "output" },
    { "kind": "process.exec", "argv": ["sips", "-Z", "1600", "…"], "cwd": "/Users/x/Pictures" },
    { "kind": "network",      "allowed": false }
  ],
  "createdAt": "…", "expiresAt": "…(+120s)",
  "sessionId": "uuid", "nonce": "uuid",
  "signature": "ed25519 over canonical JSON of everything above"
}
```

- **Signing:** canonical JSON (sorted keys, ISO-8601 dates) signed Ed25519.
  In v1 the broker holds agent private keys and signs on the agent's behalf
  (the agent *runtime* holds the key — Claude Code itself can't do crypto);
  the device verifies against the public key pinned at access-grant time.
- **Replay protection:** nonce (rejected if seen) + expiry + device-id check.
- Capability `kind`s: `fs.read`, `fs.write`, `process.exec`, `network`, `tool`.

## 5. Approval model

Two levels on every approval card:

1. **High level** — the agent's `goal` / `request` / `plan_context`. Context
   for the human; *unverifiable*, therefore never used for enforcement or rule
   matching.
2. **Low level** — the declared capability set. This is what's enforceable:
   the fine print on the card, and the source of the sandbox profile, so the
   OS-level bound always matches what was approved regardless of what the goal
   text claimed.

Decisions: **Always allow / Allow once / Deny.**

- "Always allow" stores a rule keyed on
  `(agent_id, device_id, capability-signature)` where the signature is
  SHA-256 over the *normalized* capabilities (reasons stripped, paths
  canonicalized and sorted). **Exact match**: same command template (full
  argv) and same path scopes only — `git status` approved does not cover
  `git push`; argument-level templating is future work.
- Rules are listed and revocable in the app. Goal text is never part of a rule.
- A third *observed* layer — processes spawned, files actually touched by the
  in-process file tools, sandbox denials, exit codes — lands in the audit log,
  not the approval flow. It is the raw material for the future adversarial
  reviewer and the iOS remote-approval app.

## 6. Execution & sandbox

**Minimize what needs sandboxing.** `plow_read_file` and `plow_write_file`
execute *in-process* in the device app — trusted code, bounds-checked against
the approved paths (canonicalized, symlink- and `..`-safe), inherently audited.
Only `plow_run_command` runs third-party code, and only it gets the cage.

**Seatbelt (`sandbox-exec`) with a generated profile.** The profile is not
authored by anyone — it is *mechanically derived* from the approved capability
set:

- `(deny default)` base + boilerplate any process needs (dyld, `/usr`,
  `/System`, `/dev/null`, sysctl-read, …)
- `file-read*` broadly: system dirs, the approved read paths, **and the whole
  user `$HOME`** — so user-installed tools and their configs/libraries resolve
  (`~/.local/bin`, `~/.config`, `~/.nvm`, …). Reads are the safe capability
  here; network is off unless approved, so broad read doesn't enable
  exfiltration. The command runs with the **real `$HOME`** and a `PATH` that
  includes the user bin dirs; `TMPDIR` points at the disposable scratch dir.
- `file-write*` stays scoped: the approved write paths + the scratch dir + a
  small set of tool "housekeeping" dirs under home (`~/Library/Caches`,
  `~/.cache`, `~/.config`, `~/.local/state`, `~/.npm`) so incidental cache/config
  writes don't break tools. Writes to arbitrary or system locations are denied —
  write confinement (plus network gating and per-command human approval) is the
  enforced protection.
- `network*` allowed only if declared and approved
- children inherit the profile (`process-exec` allowed)

Known caveats, accepted for v1: `sandbox-exec` is deprecated-but-load-bearing
(Chromium, Bazel, Anthropic's sandbox-runtime all rely on it); `mach-lookup`
is broad in the v1 profile (tightening tracked); TCC still gates
protected folders at the host-app level; the upgrade path for hostile
workloads is a Virtualization.framework VM. A dry-run `(trace)` mode to show
the approver what a command *would* touch is a v2 item.

## 7. Multi-Mac & multi-user (designed now, built later)

- Device addressing is in the protocol from day one; the agent's grant is a
  *set* of device IDs; `list_devices` returns per-device status and tools.
- The wire protocol stays strictly point-to-point: one intent → one device →
  one approval by **that device's owner**. Multi-device orchestration and
  partial-failure handling live in the agent, not the protocol. `plan_context`
  lets an approver on Bob's Mac see the larger task their approval serves.
- Cross-user "spaces" live at the provisioner: users share chosen devices into
  a space, optionally with a capability ceiling. **Approval authority never
  leaves the device owner** — which is why the iOS remote-approval app becomes
  essential in that milestone.

## 8. Security model & remote milestone

| Layer | v1 (local) | Remote milestone |
|---|---|---|
| Transport | Unix sockets, `0700` runtime dir | TLS to broker, cert-pinned |
| Identity | Ed25519 keys, file-backed | Device key in Secure Enclave; enrollment via pairing code shown on Mac, entered in signed-in web session |
| Channel | UDS + broker-issued agent tokens | **Noise XX end-to-end agent↔device** so the broker is a blind relay (compromised broker ≠ command injection) |
| Requests | Signed intents, nonce + expiry | Same |
| Trust root | Agent pubkey pinned at access grant (TOFU via local broker) | Pubkeys bound to provisioner accounts; revocation list; broker refuses routing for revoked agents |

Known v1 gaps (deliberate, documented): no channel encryption on loopback,
TOFU key pinning, broker holds agent private keys, no revocation UI.

The transport is abstracted behind `Connection`/`ConnectionListener`/
`ConnectionDialer` (with a `PeerTrustEvaluator`/`SPKIPin` security seam) so the
networked transport is a drop-in below `LineRPC`. The step-by-step plan to build
the network and security layers is **`docs/network-security-runbook.md`**.

**Status (remote milestone):** runbook Phases 1–6 are implemented and tested
(`Tests/DomoNetworkTests`): WebSocket transport (`WebSocketConnection`), SPKI
certificate pinning (self-signed, no public CA), enrollment + connect-time
challenge/response, an end-to-end encrypted `E2EChannel` (X25519+Ed25519+HKDF+
ChaCha20-Poly1305 — CryptoKit, no external dep) that makes the broker a blind
relay, agent revocation (broker-refuses-routing + device-authoritative), and a
hosted `wss://` deploy (`scripts/gen-broker-cert.sh`, `just broker-wss`). The one
piece not yet flipped on in the *running daemon* is relocating intent
construction/signing from the broker to the agent endpoint so the live channel is
end-to-end (the `E2EChannel` and its enforcement are complete and tested; see the
runbook's Phase 4 note). Phase 7 (iOS approval app) is out of scope for now.

## 9. On-disk layout

```
$DOMO_HOME (default ~/Library/Application Support/Plow-Latch)
├── run/agent.sock, run/device.sock      # 0700 dir
├── broker/agents.json                   # agent identities, tokens, grants
├── broker/devices.json                  # enrolled devices
├── device/identity.json                 # device keypair
├── device/known_agents.json             # pinned agent pubkeys
├── device/rules.json                    # always-allow rules
├── device/audit.ndjson                  # append-only audit log
└── device/scratch/…                     # per-run sandbox scratch dirs
```

Everything honors `DOMO_HOME` so tests run against throwaway roots.

## 10. Testing strategy

Testing is a first-class deliverable: the entire system must be exercisable
end-to-end, locally, with no UI and no human — so agents developing on this
repo can prove they broke nothing.

- **Headless device**: `domo-device` runs the identical `DomoDeviceCore` with a
  scripted policy file (`--policy`: allow/deny access, allow-once /
  always-allow / deny intents) instead of NSAlerts. The AppKit app is a thin
  shell over the same core.
- **Unit tests** (`swift test`): canonical JSON determinism, sign/verify/
  tamper, rule-key normalization, policy engine (rule reuse, deny-not-stored),
  path bounds (traversal, symlink escape), SBPL generation, real sandboxed
  execution (write-outside-scope blocked, network deny blocks a local HTTP
  fetch that succeeds when allowed).
- **E2E tests**: each test boots a fresh stack in a temp `DOMO_HOME` — real
  `domo-broker` process, real `domo-device` process, a real MCP client speaking
  JSON-RPC over the agent socket — and drives full scenarios: enrollment →
  discovery → access request → file ops → sandboxed exec → streaming via
  `plow_get_output` → always-allow rule reuse (asserted via audit
  log `source: rule`) → denial → sandbox-escape attempt → bad-token rejection.
- **Audit log as test oracle**: NDJSON, one event per line (`access_request`,
  `intent_decision {source: prompt|rule}`, `exec_start/end`, `file_read/write`,
  `denied`, …) — tests assert on it; humans read it; the adversarial reviewer
  will consume it.

`make test` runs everything. `swift test` builds all executables it spawns.

## 11. Component map

| Target | Kind | Contents |
|---|---|---|
| `DomoProtocol` | lib | JSONValue, canonical JSON, identities/signing, Capability/Intent/Grant, rule keys |
| `DomoTransport` | lib | Unix-socket server/client, NDJSON line framing, bidirectional LineRPC |
| `DomoBrokerCore` | lib | Broker state/persistence, device links, MCP session (tools, intents, signing) |
| `DomoDeviceCore` | lib | DeviceAgent, PolicyEngine + delegates, FileOps, Executor + SBPL, BlessedTools, AuditLog, GoalsLibrary |
| `domo-broker` | exec | Daemon + `create-agent` subcommand |
| `domo-device` | exec | Headless device runner (`--policy`) |
| `domo-mcp` | exec | stdio↔socket MCP shim for Claude Code |
| `DomoApp` | exec | AppKit shell: status item, NSAlert approvals, Goals/Rules/Audit window, agent spin-up |

## 11a. Local browsing (Camoufox + self-hosted vault)

The device can host a real anti-detection Firefox (Camoufox, driven by
Playwright through a vendored Python server — `vendor/browser-server/`,
provenance in its `UPSTREAM.md`) so a remote agent browses **as the local
user**: local IP, local cookies, and local credentials that are typed into the
page here rather than handed to the agent — which is driving that page, and can
read it. The pieces:

**Session grants.** Browser work is hundreds of small actions; per-action
intents would be approval spam and "always allow browser_goto" would be an
unbounded rule. Instead one signed intent opens a **session** whose capability
is the enforceable bound — a `browser` capability with an origin allowlist
(`origins: ["dominos.com", "*.dominos.com"]`, explicit patterns, no PSL
logic) and optionally `credential` capabilities. Subsequent commands ride the
session handle over the `browser_command` RPC with no new intent — the same
trust model as `get_output`. Widening scope mid-session (a checkout popup
lands on a payment provider) is a new intent with the identical capability
shape, so always-allow rules are meaningful and reusable; a fully-ruled task
runs unattended end to end (the e2e suite asserts a second session is decided
entirely by `source: "rule"`).

**Enforcement** lives in `packages/device-core/src/browser/browserSessions.ts`
— trusted TS between the agent and Playwright, because seatbelt cannot cage a
browser (network is all-or-nothing). Navigation targets are checked before
`goto`; the observed URL is re-checked after every action; popups are swept
and audited; on an out-of-scope page the session locks — nothing can be
observed or interacted with except finding the way back. **Stated limit:** the
origin bound governs what the agent observes/interacts with and where
credentials get typed. It is *not* network egress control — page JS (the
site's own, or agent `eval`) can fetch anywhere CORS allows. That is accepted.
It used to be argued that eval carries nothing `screenshot`/`text` could not
already carry; that is no longer true. Masking (§11a-ii) covers what the agent
SEES — screenshots and form reads — and cannot cover `eval`, which reads
`input.value` directly. The residual is deliberate and bounded by the threat
model: accidental exposure is what masking is for, and an agent that goes
looking for a filled value with `eval` is outside it.

**What the page's own requests did.** A browser action reports whether it
worked; it used to say nothing about whether the *page* worked. A click whose
XHR came back 401/403/429 answered `{ok: true}` on a page that had not moved,
and the owner's log recorded a plain click — the gap cost a 27-minute blind
retry loop against a sign-in that was being rate-limited, and the only way to
see the status was to hand-instrument `XMLHttpRequest` through `eval`, which is
itself an automation signal. So the server keeps the last five 4xx/5xx per
action (context-level, popups included) and every result carries them as
`failed_requests` — status, method, a **query-stripped** url (B2C hangs
`tx=StateProperties=` there), size, `Retry-After` and `Server`. Never a body: a
body can echo a submitted credential. Bounded because the relay buffers a whole
exchange. The browser reports and forgets; **`BrowserHost` holds them** until
an agent action carries them out. That is deliberate: most of what asks the
browser anything is the device itself — the owner's ~1/s viewer poll, the popup
sweep, the frame lookup before a credential fill — and whichever of those was
in flight would otherwise be the one that consumed a 429 and dropped it.
Every response passes through one place, so that is where they wait.
Each entry names the document that asked (`frame_url`) as well as what it asked
for. A navigation names itself, but only when it answers the **`goto` this
session issued** — the active page's main frame going where that `goto` sent
it, through however many redirects. That exception exists because the frame has
not committed the new url yet when the headers arrive, so asking it would name
the page being left, and a refused `goto` would be credited to the page the
agent was leaving. Everything else is named by whoever drove it: a subframe by
the frame that embedded it, and a background popup or a page scripting its own
`location` by the document that frame is still showing — never by the url it
chose. `back` lands somewhere not
known in advance, so it claims nothing, and `use_page` clears the pointer along
with the page it belonged to. A frame that cannot be resolved at all (a service
worker's request, a popup before its frame exists) names nothing. The rule
behind all of it: a page must never get to write the agent's evidence by
choosing a url.
`BrowserSessions` re-strips the query from both `frame_url` and
the requested url before either reaches the agent or the audit log.

**The owner's log gets every entry** — an out-of-scope page being refused
is exactly what they are watching for, and whatever is still held when a session
closes or the browser dies goes on the closing line. **The agent gets only the
entries with both ends inside the approved origins**, judged per entry rather
than by where the action landed: a refusal on the approved page still matters
when a sign-in redirect has parked the session elsewhere, and an unapproved page
must not get to choose the text it hands the agent by choosing what to fetch.

**Credentials.** A `credential` capability is separate and explicit on the
approval card: `access: "metadata"` (list vault item names/field labels —
never values) or `access: "fill"` with item ids. The vendored
`seed_vault_broker` CLI wraps the bundled `bw` (an agent account scoped to one
vault's collections). `fill_secret`
is the strongest gate, in order: item ∈ approved set → the selector is located
to its owning frame → the frame's origin ∈ session scope → `seed-vault-broker
get-field` against the **device-observed** frame URL (its own eTLD+1 item/site
check applies; credit cards deliberately pass — they are meant for any
merchant) → a frame-targeted fill → the value is dropped. Secret values never
traverse MCP, never appear in the results these tools return, and never appear
in either audit log. **Scope of that guarantee:** it covers what `plow_vault`
and `fill_secret` hand back, and — through masking (§11a-ii) — what a
screenshot or `forms` shows. It does not cover `eval`, which reads
`input.value` directly; that is the documented residual, accepted because the
threat model is accidental exposure and an agent reaching for `eval` is
outside it.
Item ids on the approval card are resolved to titles **locally** (agent-supplied
titles would be spoofable).

**The owner's live view.** While a browsing session is open, the audit
screen's detail pane shows a small near-live mirror of what Camoufox is
showing, pinned in the pane's bottom-right corner outside the timeline scroll
(~1 frame/s, a `view` server action that never touches disk). Frames ride
`BrowserHost.viewFrame()` — deliberately *outside* `BrowserSessions`: session
scope bounds what the **agent** observes, and the owner watching an
out-of-scope page is exactly the oversight the view exists for (the caption
flags "Out of approved scope"). `viewFrame` is strictly best-effort — it never
starts the browser, never throws, and a ~1/s poll writes nothing to the audit
log. The thumbnail appears only while a session is active and disappears when
it closes.

**Skills.** Devices publish skills (name/description/markdown body,
`SkillRegistry`); agents discover them via `plow_list_skills` and read them
with `plow_read_skill`. The built-in
`camoufox-browsing` skill is the operator manual for this tool surface.

**Runtime & packaging.** The stack ships inside the app: a relocated
python.org universal2 Python 3.12 + lipo-merged (delocate) universal
site-packages + one lipo-fused universal Camoufox tree (both arches' Mach-Os
fused, the arch-independent payload shipped once), built deterministically by
`scripts/build-browser-runtime.mjs` from hash pins in
`vendor/browser-server/runtime.lock.json` (version coupling
camoufox 0.5.4 ↔ playwright 1.60.0 ↔ browser 152.0.4-beta.28 is strict). The
build prunes what can never load at runtime (Camoufox's bundled Windows/Linux
spoofing fonts — the vendored server pins the fingerprint to macOS — plus
Python test suites, dSYMs, headers, bytecode caches). The payload is
byte-identical in both electron-builder arch passes so the universal merge
copies it through. The Camoufox payload is a complete
`camoufox fetch`-layout install dir; `BrowserHost` spawns the server with an
app-scoped `$HOME` whose `Library/Caches/camoufox` symlinks to it — the
user's shared cache is never touched and no fetch happens at launch. Audit
events (`browser_*`, `credential_*`) are the test oracle; the fake browser
server + fake `op` fixtures make the whole flow CI-testable without Python,
and `just test-browser` runs the real browser against a local checkout
fixture site.

### 11a-i. The vault's Keychain identity is frozen, and it is not the app's name

The vault account's password is stored as ciphertext on disk and the key lives
in the macOS Keychain, via Electron's `safeStorage`. Three facts about
`safeStorage` decide the design, and all three were learned by breaking it:

1. It has no key of its own. On macOS it looks up a Keychain item named
   `<app.name> Safe Storage` (account `<app.name> Key`) and uses the password
   in it. **The encryption key is addressed by a display string.**
2. It captures that name at **startup, before `app.whenReady`**, and holds one
   key for the life of the process. Setting `app.name` after ready does not
   move it — measured: the Keychain item appears under the pre-ready name and
   never under the post-ready one. **One process gets exactly one key.**
3. Therefore **renaming the app orphans every ciphertext it has written.**

Renaming the app to "Plow" (PR #42) did exactly that: `safeStorage` looked for
`Plow Safe Storage`, found nothing, minted a fresh random key, and four
colleagues' vault accounts stopped opening. Nothing was lost — the old key and
the ciphertext were both intact — but nothing in the app could reach them.

So the identity is a **frozen literal** in
`packages/device-core/src/browser/vaultKeychain.ts`, deliberately still spelling
the *old* app name, because that is what every existing vault was encrypted
under. Freezing it means the ciphertext on disk keeps working with no
migration, no re-encryption and no prompt. It is not derived from `app.name`,
`appId` or `productName`, and the fact that it no longer matches the product's
name is the point.

Fact (2) dictates where this happens: `app.setName(instance.vaultIdentity)` runs
at module top level in the Electron entry, before ready, because that is the
only moment the Keychain is listening. The product name is restored as the first
statement inside `whenReady` — early enough for every menu, window and tray item,
all of which are built after it. A helper that wrapped a "latch" call cannot
work: by the time any code inside `whenReady` runs, the name is already
captured. (This was got wrong once, in exactly that way, and produced a fix that
changed nothing.)

Two rejected alternatives, recorded so they are not re-proposed:

- **Copy the Keychain key to a new identity.** macOS gates reading another
  application's Keychain item behind an authorization prompt that asks for the
  login password and names the `security` binary — an alarming dialog to show
  someone at app launch, and one that strands the old key permanently if it is
  dismissed (`safeStorage` mints a replacement, and the migration then looks
  complete forever).
- **Decrypt under the old name in a child process and re-encrypt under a new
  one.** Correct, silent, and unnecessary machinery for a problem that a frozen
  string solves outright — and every extra moving part sits between a user and
  the only copy of their credentials.

There is no recovery for a genuinely lost key, and the UI must not invent one:
an account that cannot be decrypted cannot be signed in with, here or anywhere,
because the password it would need is the thing that is unreadable. The copy says
so — the account is on disk, nothing is deleted, and if the key is gone the vault
has to be set up again.

The owner reaches the vault's CONTENTS in the app, never on the vault's own page:
`VaultClient` signs in with the account this Mac already holds and reads and
writes items over the vault's API, so there is no CLI process, no local port and
no session key on disk. The tab shows the locked state from
`readCredentialsState()` and nothing else about the account.

A locked vault must also never be reported as an empty one. `readState()`
distinguishes empty / locked / ok, because a Keychain reset or a Mac restored
from backup lands in exactly this state, and "The vault has not started yet"
sends people to debug a server that is running fine.

### 11a-ii. A filled secret is masked from what the agent sees

`fill_secret` types a vault value into a page, and the value then sits in
`input.value` where the agent could read it straight back — as pixels from
`screenshot`, and as characters from `forms`. That is how it was found: a card
number and CVC plainly legible in a returned screenshot.

**A field is masked from the agent if and only if the vault itself masks it.**
The classification is Bitwarden's, and thereby the human's who made the item —
a password, a card number and code, an ssn, a Hidden custom field. Addresses
and names stay legible on purpose: the agent has to be able to check a shipping
address before submitting a form. One deliberate exception: a generated TOTP
code is masked although the client shows it, because an agent fills it and
never needs to read it, and it is a live credential for its half-minute.

The mark is one `data-domo-secret` attribute plus one injected stylesheet rule,
applied to the resolved node at fill time and verified against the computed
style before the value is typed — a page whose CSP blocks the stylesheet gets
no value at all rather than a legible one. `forms` reports a marked field as
present without its characters, and never returns a `type="password"` value at
all. Full design, including the alternatives rejected and why, in
`docs/superpowers/specs/2026-08-18-secret-masking-design.md`.

**What it does not cover: `eval`.** It reads `input.value` directly and no mark
changes that. Accepted residual: the threat model is accidental exposure — a
well-behaved agent looking at a page in the ordinary course of its work — and
an agent reaching for `eval` to read a field it just filled is outside it.

## 11b. Software updates

The packaged app self-updates via **electron-updater** (generic provider — no
update server). electron-builder bakes the feed URL into the app; the feed is
static files on the same S3 bucket Phoenix's Sparkle appcast uses:
`https://s3.us-west-2.amazonaws.com/releases.plow.co/domo/latest-mac.yml`, with
the update zip beside it. Auto-update needs the `zip` target (Squirrel.Mac
cannot consume a DMG); both artifacts come from the one signed, notarized pack.

Decisions and their reasons:

- **Only the packaged install updates.** `main.ts` constructs the
  `UpdateController` behind `app.isPackaged`, so from-source/worktree runs
  never poll the feed. This composes with the worktree state model (§13): only
  the packaged install uses the unsuffixed `Plow-Latch` home.
- **Nothing about updates is modal.** Downloads are automatic and silent; a
  staged update surfaces as a passive banner in the main window, a tray item
  ("Restart to Update"), and the Software Updates settings section — never a
  dialog, which could interrupt an approval decision. A restart tears down
  live agent sessions, so it happens only on the human's click or at a
  natural quit. Two preferences, both default-on: "automatically check"
  (gates the 4-hour background cadence; a manual check always works) and
  "install when quitting" (`autoInstallOnAppQuit` — the VS Code/Slack
  pattern). The menu-bar and tray "Check for Updates…" land the window on
  Settings, where version, last-check time, and the outcome are visible;
  background outcomes are never surfaced anywhere louder than that section.
- **Versions are minted by `just package`, never committed.** electron-updater
  updates on a SEMVER comparison of the feed's version — the build number
  plays no part (the opposite of Sparkle, which compares `CFBundleVersion`).
  So `package` stamps `major.minor.<UTC yyyymmddHHMM>` into the app via
  `extraMetadata` (same stamp as `CFBundleVersion`), making every packaged
  build — local ones included — semver-newer than everything packaged before
  it. A locally installed package is never yanked back by the stable feed, any
  candidate is promotable, and no version-bump commit gates a release.
  package.json owns only `major.minor` (bump it when the release deserves it);
  its patch digit is dead. Cost: user-visible versions are long and
  date-shaped, Chrome-style — accepted for the zero-commit pipeline. The git
  commit is stamped alongside (`DomoGitCommit` in Info.plist, `gitCommit` in
  the app's package.json, `-dirty` when the tree isn't clean), because the
  artifact travels alone: CI builds are tagged in git, local builds aren't,
  and either way a DMG on a desk should answer what it was built from.
- **Versioned-then-promote, human-gated** (mirrors Plow's Phoenix pipeline):
  `just release` uploads to `domo/releases/<version>-<build>/` where nobody's
  app looks; a human publishing the draft GitHub release fires the promote
  workflow, which copies artifacts onto the stable keys — feed last, because
  writing `latest-mac.yml` is the ship moment. `just promote` is the manual
  equivalent. Trust comes from the sha512 in the feed plus the Developer ID
  signature; there is no Sparkle-style appcast key.
- The update controller is pure over injected seams (`updates.ts`,
  `updates.test.ts`) per the testing rule — updater, dialogs, and clock are
  all injectable.
- **The whole loop is testable locally, no S3.** `DOMO_UPDATE_FEED_URL`
  points a packaged build at any feed (honored unconditionally — Squirrel.Mac
  only installs updates signed by the same Developer ID, so a hostile feed
  can offer nothing the app accepts), and `just serve-updates` serves this
  checkout's `apps/desktop/release/` as that feed. Package twice, install A,
  serve B, launch A with the override + a throwaway `DOMO_HOME` — the recipe
  comment in the justfile walks through it.

Known cost: the DMG and zip each carry the full browser runtime (the fused
universal Camoufox tree + Python — the DMG-halving work in §11a shrank it,
but it still dominates the artifact), so updates are large. Blockmap
differential downloads may soften this; shipping the browser runtime
out-of-band (it is already pinned by `runtime.lock.json`) is the eventual fix
if update size becomes a problem.

## 12. Roadmap

1. **v1 (this repo, now):** everything above, local, tested.
2. **v1.x:** Noise channel over loopback; Keychain/SE device key; rules
   management UI polish; `(trace)` dry-run preview; tighter `mach-lookup`.
3. **Remote:** cloud broker (same wire contract), WebSocket transport, pairing
   codes, revocation; iOS approval app.
4. **Multi-user:** spaces, capability ceilings, cross-owner approvals.
5. **Adversarial reviewer:** an agent consuming the same intent + audit stream,
   sitting between policy and prompt as an additional gate.

The remote milestone is where the **TypeScript re-platform (§13)** lands: the
hosted broker ships as the first TS component, and the rest of the system
follows behind the same wire contract.

## 13. Re-platform: TypeScript + Electron (migration plan)

**Status:** plan recorded 2026-08-09; port landed 2026-08-09; **Swift removed
2026-08-10 (Phase T6 complete)** — the TypeScript stack (protocol, transport,
broker, device core, headless runner, and the Electron app) is now the only
implementation. The Swift sources, tests, `Package.swift`, `Makefile`, and the
Swift-era `scripts/` have been deleted. `fixtures/` — originally generated by
the Swift golden-vector tool — is **frozen as the protocol spec**: the TS suite
asserts against it, and any change to those bytes is a deliberate protocol
break. See `README-ts.md` for the layout and CLAUDE.md for the working rules.

**What landed:**
- `packages/{protocol,transport,broker-core,device-core}` + `apps/{broker,mcp,device,desktop}`.
- `fixtures/*.json` golden vectors, asserted byte-for-byte by the TS suite
  (canonical JSON, intent/grant signing bytes, rule keys, E2E key schedule +
  AEAD frame, connection strings, path canonicalization, SBPL). Generated by the
  Swift implementation during the migration; now frozen (the generator is gone).
- Mixed-stack E2E: every scenario runs TS/TS, TS-broker+Swift-device, and
  Swift-broker+TS-device (the last two when `.build/debug` exists) — the wire
  contract is proven across implementations.
- CI on macOS **and** Linux (`.github/workflows/ts.yml`); sandbox/E2E tests are
  macOS-guarded (seatbelt), protocol/transport run everywhere.

**Findings worth carrying forward:**
- **CryptoKit Ed25519 signatures are randomized** (Apple adds entropy), so
  signature *bytes* are not reproducible across runs/languages. Signature
  conformance is therefore cross-*verification*, not byte-equality; the *signed
  bytes* (canonical JSON) are the byte-identical artifact. Node's `crypto.sign`
  is deterministic (RFC 8032) — both verify each other's signatures.
- Node's `fs.realpathSync` is `realpath(3)` and preserves `/private`, so the
  `PathUtil` invariant ported without the Swift `resolvingSymlinksInPath`
  footgun.
- `DomoConnection` compact strings escape `/` in the payload JSON (the Swift
  encoder omits `.withoutEscapingSlashes` there), unlike canonical signing
  JSON which does not — the TS twin matches each context exactly.

### 13.1 Why

- **The broker's future is a Linux service** (§1 "cloud service run by the
  provisioner") with a web front-end for pairing. Swift-on-Linux is possible
  but means porting the transport off Apple's Network/Security frameworks and
  running a web stack beside a Swift daemon; TypeScript is the native language
  of both the deployment target and the front-end.
- **MCP's official SDK is TypeScript-first.** `MCPSession` and `domo-mcp`
  hand-roll the protocol today; the rewrite deletes protocol code.
- **One language restores single-source invariants.** The device stays on
  macOS forever, so a TS broker with a Swift device would mean two
  implementations of the signature-critical canonical-JSON/crypto layer.
  Migrating the device too collapses the system back to one implementation —
  the property this design was built around.
- **Electron over Tauri/webview shells:** Domo's device app is ~90% privileged
  daemon (spawn `sandbox-exec`, stream stdio, WebSocket client, crypto, audit
  log) and ~10% UI. Electron is the only option where that daemon is plain
  Node in the main process — no second systems language, no IPC seam to a
  sidecar. The accepted costs: bundle size, and owning the Chromium update
  cadence via autoupdate.

### 13.2 What does NOT change

The re-platform is a change of implementation language, not of design.
Invariants carried over verbatim:

- The **wire protocol** (intents, capabilities, canonical JSON, Ed25519,
  E2E channel) and the **on-disk layout** (§9) are frozen across the
  migration — they are the seam that makes mixed Swift/TS stacks testable.
- **Enforcement derives from approved capabilities, never goal text** (§5).
- **Canonicalization returns true physical paths.** Node's `fs.realpath` is
  `realpath(3)` and preserves `/private`; the Swift-Foundation
  `resolvingSymlinksInPath` footgun does not exist in Node, but the invariant
  and its tests carry over.
- **Sandboxing mechanism unchanged:** spawn `/usr/bin/sandbox-exec` with an
  SBPL profile mechanically derived from the capability set (§6). Profile
  generation is pure string-building and must produce **byte-identical SBPL**
  to the Swift generator (golden-tested).
- **Everything honors `DOMO_HOME`; audit log stays append-only NDJSON and
  stays the test oracle** (§10).
- Consent-UI rule, restated for a web renderer: the approval window renders
  **only** from the verified canonical intent — never remote content, never
  agent-controlled markup. `contextIsolation` on, `nodeIntegration` off,
  renderer sandbox on.

### 13.3 Target shape

Monorepo mirroring the current module seams one-to-one:

| Package | Replaces | Notes |
|---|---|---|
| `@domo/protocol` | `DomoProtocol` | canonical JSON, identities, Capability/Intent/Grant, rule keys |
| `@domo/transport` | `DomoTransport` | NDJSON framing, LineRPC, UDS, WebSocket (`ws`), E2EChannel |
| `@domo/broker-core` | `DomoBrokerCore` | Broker, BrokerStore, MCP surface via `@modelcontextprotocol/sdk` |
| `@domo/device-core` | `DomoDeviceCore` | DeviceAgent, PolicyEngine, FileOps, Executor+SBPL, AuditLog, SkillRegistry |
| `apps/broker` | `domo-broker` | Linux deploy target; TLS in-process or behind a reverse proxy per the runbook |
| `apps/mcp` | `domo-mcp` | stdio shim on the official SDK |
| `apps/desktop` | `DomoApp` | Electron: device-core in the main process; tray, approval windows, Goals/Rules/Audit |

Runtime decisions: **Node LTS everywhere** — Electron's main process is Node,
so standardizing on it keeps one runtime; Bun may be used as a dev-time runner
but CI proves Node. Crypto via `node:crypto` (Ed25519, X25519, HKDF-SHA256,
ChaCha20-Poly1305 — the full existing suite), with audited `@noble/*`
fallbacks only if a gap is found. Key storage starts file-backed (today's
tested default); Electron `safeStorage` is the Keychain-hardening milestone.

### 13.4 Phases

Strangler pattern: the wire protocol is the seam; every phase ends with the
mixed stack passing the full E2E suite against the audit-log oracle.

**Phase T0 — scaffold.** Monorepo, TypeScript strict config, CI on macOS
*and* Linux from day one. No behavior.

**Phase T1 — protocol + golden vectors.** Port `@domo/protocol`. The first
deliverable is a **conformance fixture set generated by the Swift code**:
(JSON value → canonical bytes), (intent → signing bytes → signature →
verify), rule-key normalization cases, E2EChannel transcripts, and generated
SBPL profiles. Both test suites assert the same fixtures; the Swift side keeps
generating them until it is deleted, after which the fixtures are frozen as
the protocol's specification artifact. Byte-level risks to pin down here:
JSON number formatting (JS doubles vs Swift), Unicode escaping, key ordering,
ISO-8601 rendering. *Acceptance: every fixture passes in both languages; a
fuzzer round-trips values through both encoders with identical bytes.*

**Phase T2 — transport interop.** NDJSON framing, LineRPC, UDS, WebSocket,
E2EChannel in TS. *Acceptance: four-way interop tests — TS↔TS, Swift↔Swift,
TS client↔Swift server, Swift client↔TS server — including a full E2E-channel
handshake and tamper rejection.*

**Phase T3 — broker + mcp ship first.** `@domo/broker-core` + `apps/broker` +
`apps/mcp`, MCP via the official SDK. This supersedes the Swift/Linux port and
completes the hosted-broker story (§8) on standard infra. *Acceptance: the
existing E2E scenarios pass with **TS broker + Swift device**; hosted-wss
deploy recipe from the runbook reproduced on a Linux host.* The TS broker
becomes the deployed broker at this point; Swift broker enters maintenance.

**Phase T4 — device core, headless first.** Port `@domo/device-core` and a
headless `domo-device` with the same `--policy` scripting. The sandbox tests
are the bar: write-outside-scope blocked, network-deny blocks a local fetch
that succeeds when approved, symlink/traversal bounds, SBPL byte-parity.
*Acceptance: full E2E suite green with TS broker + **TS device**; audit
streams from Swift and TS devices are event-for-event comparable.*

**Phase T5 — Electron app.** `apps/desktop`: device-core in the main process;
tray, approval flow, onboarding/TOFU, Goals/Rules/Audit windows; signing +
notarization + hardened runtime (spawning `sandbox-exec` verified under it);
autoupdate wired so Chromium patches ship on cadence. UI smoke follows the
existing philosophy — real input events, not synthetic accessibility calls —
via Playwright's Electron driver plus the CGEvent click harness. *Acceptance:
`ui_smoke` parity with today's checks (first-mouse row selection, agent
spin-up with spaces in paths).*

**Phase T6 — decommission Swift.** After the TS stack has run the full suite
and real sessions for a stable period, delete the Swift targets; freeze the
golden vectors in-repo as the protocol spec; update CLAUDE.md (build/test
commands, layout, the AppKit rule) in the same change. Keep the option of
tiny native helper binaries for future blessed tools that need
AppleEvents/XPC — none are needed today.

### 13.5 Risks

| Risk | Mitigation |
|---|---|
| Canonical-JSON drift between languages during T1–T5 | Golden vectors as first deliverable; fuzzing both encoders; Swift stays the generator of truth until deleted |
| JS has only doubles | Canonical encoder pins integer/float rendering rules; vectors cover the edges; protocol avoids non-integer numbers where possible |
| Consent UI is a web renderer | §13.2 hygiene rules; approval window is a spoofing target and gets its own tests |
| Chromium CVE cadence becomes ours | Autoupdate is wired in T5, not later; releases track Electron stable |
| `sandbox-exec` deprecation | Unchanged from §6 — same risk in both languages, same VM upgrade path |
| Node single-threaded event loop vs concurrent sessions | Broker is I/O-bound routing; long work (exec streaming) is child-process-bound; no shared-memory concurrency exists today to lose |
