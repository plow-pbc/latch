# Domo — Design Document

**Status:** v1 (local loop) — decisions locked 2026-08-08
**Audience:** Domo developers and agents working on this codebase.

Domo lets a remote AI agent (Claude Code or any MCP-speaking agent) use a
person's Mac — read and write files, run CLI commands with streaming output,
and drive a real browser on their machine — through an **intent-based request
system**: every operation is a structured intent that a human and an
adversarial reviewer agent can inspect and approve, with the configured
approval mode deciding which of them is consulted, before it executes inside an
on-the-fly sandbox derived from exactly the approved capabilities.

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
  explicitly declared (and therefore approved). The one exception is a
  vendored provider command (`packages/device-core/src/providers/registry.ts`,
  which owns the account of what a provider is): anything that is not a help
  invocation — `--help`/`-h` last, with no `--` before it — reaches its
  service by definition, so the capability is added regardless of the field —
  omitted, or explicitly `false`. Nothing is hidden by this; it is in the
  capability set the human approves, and a provider call approved without it
  is a call the sandbox then denies.

## 4. The intent object

Every operation (file read/write, command, browser session) becomes one intent
— the single artifact that the approval UI renders, the sandbox is derived
from, the audit log stores, and the adversarial reviewer evaluates.

```json
{
  "intentId": "uuid",
  "agentId": "fingerprint", "agentDisplay": "Family Coordinator",
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
  "sessionId": "uuid", "nonce": "uuid"
}
```

- **Signing:** the intent carries none. It is never *received* over the wire —
  it is built on this Mac from an authenticated agent's tool call — so there is
  no third party's signature to verify. That is not a data-locality claim:
  whenever the reviewer runs — the default adversarial mode's verdict and `ask`
  mode's suggestion hint both call it — four things are posted to Plow's
  chat-completion endpoint (`apps/desktop/src/adversarialAgent.ts`): the
  agent's display name and id, the request composed on this Mac, the requested
  capability bounds, and the owner's own `agentPurpose` text, which rides in
  the system message. Nothing else does — no goal text, and no audit history:
  `reviewPolicy.ts` passes `history: []` deliberately, and `buildPrompt`
  explains why. WHETHER it runs is decided in precedence order by
  `packages/device-core/src/policyEngine.ts`: a stored always-allow rule
  short-circuits Ask and Approve, while global AI Reviewer and Deny modes decide
  every request. What *is*
  signed is the **Grant**: the device's Ed25519 signature over canonical JSON
  (sorted keys, ISO-8601 dates), the Mac attesting to its own decision.
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
  not the approval flow. It is the raw material for the future iOS
  remote-approval app — not for the adversarial reviewer, which is handed
  `history: []` (§4).

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
  writes don't break tools — except a run that may be reaped for going silent,
  which gets none of them (`SANDBOX-BOUNDARY.md` §1). Writes to arbitrary or
  system locations are denied — write confinement (plus network gating and
  per-command human approval) is the enforced protection.
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

> **Historical.** This section records the broker-era security model — signed
> intents, pinned agent keys, a Noise channel making the broker a blind relay.
> The broker is gone; see `CLAUDE.md` and §4 for what ships. Retained as the
> record of what was decided and why (issue #137).

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
the network and security layers was **`docs/network-security-runbook.md`**, now
marked superseded — it plans the removed broker and must not be executed.

**Status (remote milestone) — historical; this records the broker-era security
model, which was removed with the broker.** Runbook Phases 1–6 were implemented
and tested (`Tests/DomoNetworkTests`): WebSocket transport
(`WebSocketConnection`), SPKI certificate pinning (self-signed, no public CA),
enrollment + connect-time challenge/response, an end-to-end encrypted
`E2EChannel` (X25519+Ed25519+HKDF+ChaCha20-Poly1305 — CryptoKit, no external
dep) that makes the broker a blind relay, agent revocation
(broker-refuses-routing + device-authoritative), and a hosted `wss://` deploy
(`scripts/gen-broker-cert.sh`, `just broker-wss`). All of it went with the
Swift sources; none of it ships.

## 9. On-disk layout

```
$DOMO_HOME (default ~/Library/Application Support/Plow-Latch)
├── app/settings.json                    # 0600; the relay credential, sealed
├── app/telemetry.json                   # the install id telemetry reports under
├── app/crash-report.json                # one spooled crash, removed once sent
├── device/identity.json                 # 0600; device keypair
├── device/rules.json                    # always-allow rules
├── device/approvals/<intentId>.json     # 0700 dir; approvals IN FLIGHT only
├── device/audit.ndjson                  # append-only audit log
├── device/audit.1.ndjson                # the generation before it, once rotated (readers take both)
├── device/browser/fingerprint-pin.json  # the one fingerprint this install presents
├── device/browser/profile/              # the owner's browser profile (seed)
├── device/browser/profiles/<session>/   # per-session clones; merged and removed on close
├── device/scratch/<run>/                # per-run sandbox scratch; removed after the run
├── electron/                            # Electron's userData (Chromium caches)
└── plow-wire.log                        # rolling 2MB: method, URL, status, ms — no bodies
```

Everything honors `DOMO_HOME` so tests run against throwaway roots.

Nothing here grows without bound. An approval record exists from before the
human is asked until its decision is in the audit log (a crash in between is
replayed from the record on the next start), which rolls over by rename at
`AUDIT_ROTATE_BYTES` (one previous generation kept). A session's profile clone
goes when the session closes. Screenshots are never written to disk: the agent
gets them inline and the owner's viewer takes live frames. An install from
before this held a `device/browser/screenshots/` directory of every page an
agent had looked at; the app removes it on start.

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
  `denied`, …) — tests assert on it and humans read it. The adversarial reviewer
  does NOT: it is handed `history: []` on purpose (§4).

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

## 11a. Local browsing (Camoufox + local vault)

The device can host a real anti-detection Firefox (Camoufox, driven by
playwright-core through a TypeScript server — `@domo/browser-server`, ported
from the retired vendored Python and keeping the same JSON-lines stdio wire, so
no Python ships) so a remote agent browses **as the local
user**: local IP, local cookies, and local credentials that are typed into the
page here rather than handed to the agent — which is driving that page, and can
read it. Several browsers can run at once and they are all the user's: Firefox
locks a profile to one process, so each session runs on a **clone** of the
user's profile (APFS clonefile — no wait, no extra disk), so every browser opens
signed in where they left off. On close the clone's cookies are MERGED into
that profile — row by row, keeping whichever was used last — so a sign-in made
inside a session sticks, and two browsers signed into two different sites both
keep theirs. Replacing the profile wholesale, which is the obvious version of
this, would let the last browser to close decide what the user is signed into.
Ceiling: cookies only, so a site that keeps its session in localStorage still
signs out with the clone. The pieces:

**Session grants.** Browser work is hundreds of small actions; per-action
intents would be approval spam and "always allow browser_goto" would be an
unbounded rule. Instead one intent opens a **session** whose capability is
the enforceable bound — a `browser` capability with an origin allowlist
(`origins: ["dominos.com", "*.dominos.com"]`, explicit patterns, no PSL
logic) and optionally `credential` capabilities. Subsequent commands ride the
session handle over the `browser_command` RPC with no new intent. The handle
says WHICH browser, not whose: unlike `get_output`, which is checked against
the agent that started the job, this Mac is one person's and every browser on
it is theirs, so whoever holds a handle can drive that browser. Widening
scope mid-session (a checkout popup lands on a payment provider) is a new
intent with the identical capability shape, so always-allow rules are
meaningful and reusable; a fully-ruled task runs unattended end to end (the
e2e suite asserts a second session is decided entirely by `source: "rule"`).

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
retry loop against a sign-in being rate-limited, and the only way to see the
status was to hand-instrument `XMLHttpRequest` through `eval`, which is itself
an automation signal. So the server keeps the last five 4xx/5xx per action
(context-level, popups included) and every reply an action produces drains
them — an error as much as a result, since a refusal that only rode success
replies is the one nobody would ever see. Never a body: a body can echo a
submitted credential. `BrowserHost` holds them until an agent action carries
them out, because most of what asks the browser anything is the device itself
(the ~1/s viewer poll, the popup sweep, a credential fill's `locate`) and
whichever was in flight would otherwise consume a 429 and drop it.

**What a page asked for, not where the agent went.** A refused *top-level*
navigation is the visible case — the agent goes somewhere, is refused, and the
page is right there in its next screenshot. Everything else a page asks for on
its own account is invisible, a payment or sign-in iframe that will not load
included, and that is what is kept. A frame's own document load names nobody:
nothing can say whether the frame moved itself or its embedder moved it, and
blanking a frame makes either look like the other. So the owner's log keeps
those and the agent does not see them — it learns of a frame that will not
load from what that frame asks for once it has, which is attributable.

**Origins, and both ends of them.** A url is the page's to choose, and every
part of one but the origin can carry a secret — a query, userinfo, and a path
as much as either, since `/reset/<token>` is a url sites really send. So an
entry is the origin that refused, the origin that asked, the status and the
method, and nothing else; the owner's log gets all of it, and the agent is
told `{status, method, host}` (plus `Retry-After`/`Server` when sent) only
when **both** origins are inside the session's. Destination alone would let a
page the session is locked out of fetch a url it knows will fail on an
approved host and pass that off as the approved page's own trouble. Who asked
is read when the request is MADE, not when it is answered: a page that asks
for something it knows will fail and then moves itself to an approved origin
would otherwise have the refusal read as that origin's. A request the browser
cannot attribute — a sub-frame's own document load, a service worker's
request, one it never saw asked — names nobody and is withheld from the agent
while the owner still sees it.

**Credentials.** A `credential` capability is separate and explicit on the
approval card, and there is exactly one: `access: "fill"` with item ids.
Inventory — vault item names, usernames, sites and field labels, never values —
is read through `plow_vault` (`list`/`describe`), which carries no capability
and asks for no approval; it is recorded in the owner's audit log as
`credential_metadata` with `source: "vault"`. There was a second, session-scoped
`access: "metadata"` capability whose grant nothing consumed; it was removed
rather than wired, so inventory is ungated in one place instead of being
documented as gated in two. The broker runs **in-process**
(`brokerCore.ts` over the local vault store; the classifier that decides what
each item offers and conceals is `credentialClassify.ts`, a faithful port of
the Python broker this replaced, still asserted against
`fixtures/maskClassification.json`). `fill_secret`
is the strongest gate, in order: item ∈ approved set → the selector is located
to its owning frame → the frame's origin ∈ session scope → **a fill whose
device-observed destination matches the bundled v1 bank registry additionally
requires a separate, single-use owner payment approval, consumed from plow's
`POST /v1/payment-approvals/consume`; the release proceeds ONLY when that
returns `approved`, and any other answer — not approved, a non-2xx, an
unreachable service, or no client wired — blocks fail-closed** → the broker's
`getField` against the **device-observed** frame URL (its own item/site check
applies, by label-suffix host match whose root is checked against the pinned
Public Suffix List — the one PSL use in this repo, because here the code
infers site relatedness on its own rather than matching an owner-approved
pattern; credit cards deliberately pass the check — they are meant for any
merchant) → a frame-targeted fill → the value is dropped. Secret
values never traverse MCP, never appear in the results these tools return, and
never appear in either audit log. **Scope of that guarantee:** it covers what
`plow_vault` and `fill_secret` hand back, and — through masking (§11a-ii) — what
a screenshot or `forms` shows. It does not cover `eval`, which reads
`input.value` directly; that is the documented residual, accepted because the
threat model is accidental exposure and an agent reaching for `eval` is
outside it.
Item ids on the approval card are resolved to titles **locally** (agent-supplied
titles would be spoofable).

**Segmented code controls** (a 2FA screen's six one-digit boxes) get a split
variant of the same gate: `fill_secret` takes `selectors` — every box in
order — instead of `selector`. The split cannot happen on the agent's side,
because the agent never has the value; it happens on the device, after one
vault release, with every box located up front and required to sit in the one
document whose origin was checked. Each box then gets exactly one character
(masked when the field is), and a fill that fails part-way erases the boxes it
already wrote before reporting, so no partial live code is left in the form.
The erase rides the same mask the characters went in under — the browser's
unmasked fill path takes the mark off before it learns what the node kept, so
a controlled input that undoes the empty write would otherwise show its
character to every later screenshot — and a box the page refuses to empty is
named in the error and the owner's log rather than claimed cleared, its mark
still on.
The browser server deliberately refuses to type a whole code into box one
(`server.py` `_type_value`: per-key refocus keeps every character in the node
the mark is on); this is the "one fill per box" that trade was designed around.

**Banking-credential payment gate (v1 domain registry).**
The owner grants the separate payment approval out of band — a link in the
owner thread, or a 👍 — and plow mints a single-use token that
`consume` spends at fill time. What flags a fill as "banking" today is a bundled
**bank-domain list** (`bankDomains.ts`), matched on the unspoofable
device-observed destination host. This 55-domain list is the accepted v1
detector. Listed exact domains and subdomains require a per-payment owner
approval and fail closed if approval cannot be consumed. An unlisted institution
or a credit card typed on an arbitrary merchant site does not trigger the gate;
that fail-open gap is an accepted v1 residual. Maintain the single domain list
as real usage exposes gaps. Gating **every** credential release was rejected: it
would break the agent's ordinary non-bank logins, which are the common case.

**The owner's live view.** While a browsing session is open, the audit
screen's detail pane shows a small near-live mirror of what Camoufox is
showing, pinned in the pane's bottom-right corner outside the timeline scroll
(~1 frame/s, a `view` server action that never touches disk). With a browser per
session, `BrowserSessions.viewFrame()` chooses which one the owner is watching
— the session that acted last, the same one `current()` describes, so the
picture and the words under it are always about one browser. The frame itself
still comes from that session's `BrowserHost.viewFrame()`, which is
deliberately outside session SCOPE: scope bounds what the **agent** observes,
and the owner watching an out-of-scope page is exactly the oversight the view
exists for (the caption flags "Out of approved scope"), and a ~1/s poll must
not flood the audit log. `viewFrame` is strictly best-effort — it never
starts the browser, never throws, and a ~1/s poll writes nothing to the audit
log. The thumbnail appears only while a session is active and disappears when
it closes.

**Skills.** Devices publish skills (name/description/markdown body,
`SkillRegistry`); agents discover them via `plow_list_skills` and read them
with `plow_read_skill`. Several ship built in, and the invariant is that **each
registers only when the thing it describes is actually here, as of launch** — a
resolved browser runtime, a message store present on disk, a vendored provider's
staged binary. The `DeviceAgent` constructor (`deviceAgent.ts`) is the
registration site and the canonical list of what ships; this paragraph names no
inventory, so a new skill cannot make it drift. A skill naming a capability this
Mac lacks is a guaranteed denial, so its absence is the honest answer instead. Every probe runs once, in
the `DeviceAgent` constructor — installing WhatsApp, or staging a provider,
after launch needs a restart to publish the skill. A provider carries its skill
on its registry row rather than being registered under a literal elsewhere, so
the provider's name has one spelling and a rename cannot silently unpublish it.
`whatsapp-history` is also why the registry takes a *built* skill and not only
frozen constants: its body carries the store's resolved path, so no agent has
to substitute one.
Owner-authored skills in `$DOMO_HOME/device/skills` load **last** and win a
name collision — a file the owner wrote is a deliberate act, and a built-in
default should not silently replace it.

**Runtime & packaging.** No Python ships. The stack inside the app is the
`@domo/browser-server` package (playwright-core, pure JS) plus one lipo-fused
universal Camoufox tree (both arches' Mach-Os fused, the arch-independent
payload shipped once), built deterministically by
`scripts/build-browser-runtime.mjs` from hash pins in
`vendor/browser-server/runtime.lock.json` (version coupling
camoufox-js 0.12.0 ↔ playwright-core 1.60.0 ↔ browser 152.0.4-beta.28 is
strict). The build prunes Camoufox's bundled Windows/Linux spoofing fonts (the
fingerprint is pinned to macOS, which renders with the system fonts). **The
fingerprint is not generated at runtime.** A build step samples a POOL of macOS
launch configs with camoufox-js — a build-only dependency, so its native deps
(better-sqlite3 for the WebGL model, a Rust HTTP binding) never ship — and
freezes them as `packages/browser-server/fingerprints.json`. At runtime the
server picks ONE, **pinned per install** (recorded at a per-install path, reused
every launch): a persistent browser carrying the owner's real profile and logins
wants a STABLE Mac fingerprint, and a device whose screen size or GPU changed
between sessions would be a bot signal, not a defense. The server and the cookie
merger run as Node scripts on the host process's own runtime — the app binary
under `ELECTRON_RUN_AS_NODE`, or the plain node hosting a test. **This still
commits the app to keeping Electron's `RunAsNode` fuse enabled** (a future
cleanup could move them to `utilityProcess` and drop the requirement); anyone
reaching for a fuses config must skip `runAsNode`. NO native module ships: the
cookie-store merge uses `node-sqlite3-wasm`, a WASM SQLite build that is
arch-neutral and loads under Electron with no rebuild (better-sqlite3 was tried
and rejected — it is ABI-locked, so it would have needed an Electron rebuild per
arch). Everything on the runtime path is pure JS or WASM. `browserRuntime.ts`
points playwright at
the Camoufox binary directly (no `$HOME`/cache symlink; no fetch at launch).
Audit events (`browser_*`, `credential_*`) are the test oracle; the whole flow
is CI-testable with no browser — the ported Session logic runs against stub
Playwright objects in `@domo/browser-server`'s tests, and the fake browser
server + fake `op` fixtures drive the device layer — and `just test-browser`
runs the real browser against a local checkout fixture site.

### 11a-i. The vault's key lives in the Keychain, and its identity is frozen

(Mechanical reference — formats, providers, flows, audit lines — in
[docs/VAULT.md](docs/VAULT.md); this section keeps the decisions and their
history.)

The vault is a local encrypted store: items in `items.json` (every field a
Bitwarden-format EncString — the format outlived the Bitwarden removal because
it is sound, already frozen by tests, and keeping it made migration a verbatim
ciphertext copy),
and one 64-byte master key rooted in the macOS Keychain via `vaultKeyStore.ts`.
There is no vault server, no bundled `bw`, no web vault and no vault account
any more; ~470 MB of payload left the app with them. Three providers can hold
the key, chosen once at write time and recorded in the key blob:

1. **SecItem + access group** (`@domo/native-keychain`, group
   `3559PD337Z.co.plow.vault`, service `co.plow.vault` — both frozen literals)
   — the packaged, signed app. The access group, not the bundle id, is what
   the item is keyed to, so a rename or bundle-id change cannot orphan a key.
   Chosen only when the entitlement is real (packaged builds; the probe falls
   through otherwise).
2. **`safeStorage` under the frozen identity** — `just app`: the stock
   Electron binary has no entitlement, and safeStorage's Keychain item is at
   least ACL-bound to the binary.
3. **A 0600 key file** — tests and anything with neither. Hermetic by
   construction; the file provider is what vitest exercises.

Migration from the Bitwarden vault (`vaultMigrate.ts`, permanent by decision):
the new master key IS the old account's user key, so cipher rows are copied
out of the old SQLite verbatim — no plaintext moment, crash-safe (the item
file is the single atomic write that completes it), old files left in place as
the owner's backup. That migration — and the dev-mode key
provider — is why the frozen `safeStorage` identity below still matters: it is
what decrypts the old account file, and what wraps a `just app` vault's key.

The rest of this section is the history of that identity, kept because the
relay credential still encrypts under it today. Three facts about
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
ciphertext without its key is unreadable, here or anywhere. The copy says so —
the items are on disk, nothing is deleted, and if the key is gone the vault
has to be set up again.

The owner reaches the vault's contents in the app and nowhere else:
`LocalVault` reads and writes the store directly, so there is no CLI process,
no local port and no session key on disk. The tab shows the locked state from
`readCredentialsState()` and nothing else about the key.

A locked vault must also never be reported as an empty one.
`readCredentialsState()` distinguishes empty / locked / ok — for the key blob,
and for a legacy account still awaiting migration — because a Keychain reset
or a Mac restored from backup lands in exactly this state, and an "empty"
answer is what quietly mints a fresh vault beside the owner's real one.

### 11a-ii. A filled secret is masked from what the agent sees

`fill_secret` types a vault value into a page, and the value then sits in
`input.value` where the agent could read it straight back — as pixels from
`screenshot`, and as characters from `forms`. That is how it was found: a card
number and CVC plainly legible in a returned screenshot.

**A field is masked from the agent if and only if the vault itself masks it.**
The classification is Bitwarden's (ported verbatim into
`credentialClassify.ts`), and thereby the human's who made the item —
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

### 11a-iii. Receiving an Apple Passwords export app-to-app

macOS 26's credential exchange (Apple Passwords 26.4+, "Export to Another
App…") moves credentials process-to-process — no plain-text CSV on disk, which
is exactly the exposure the Import sheet's file door has to warn about. The
app is a destination for it. Mechanics in
[docs/CREDENTIAL-EXCHANGE.md](docs/CREDENTIAL-EXCHANGE.md); the decisions:

- **The Swift surface stays a transcription.** The APIs are Swift-only, so a
  shim dylib (`apps/desktop/native/credential-import.swift`, loaded in-process
  by the `@domo/native-credential-import` addon) redeems the token — and then
  does nothing but re-emit a small versioned wire JSON of ours. Every mapping
  decision lives in `device-core`'s `parseCredentialExchange`, pure and
  vitest-frozen, and from staging onward the flow IS the existing import flow
  (§ the Vault tab's Import sheet): same staging slot in main, same preview,
  same commit, same audit lines.
- **The required provider extension vends nothing.** macOS only lists apps
  that carry an AutoFill credential-provider extension advertising
  `SupportsCredentialExchange`; there is no import-only registration. The
  shipped appex declares no `Provides*` capability and cancels every request —
  the vault's values stay owner-typed and broker-filled (§11a), never offered
  to system AutoFill.
- **Packaged builds carry it unconditionally, and packaging asserts.** The
  entitlement is profile-backed (an app carrying it beyond what its embedded
  Developer ID provisioning profile authorizes is killed at launch), so
  `just package` decodes the checked-in profiles and FAILS unless both
  actually grant the AutoFill capability — an assertion, not a switch,
  because the only alternative to failing there is signing an app the OS
  kills. afterPack then refuses a pack missing the appex, the addon, or the
  shim, exactly as it refuses one missing the keychain addon: a release
  where the feature silently stopped is what these gates exist to prevent.
  macOS 15 stays supported: the 26-only symbols are weak-linked behind
  `#available`, and the appex's `LSMinimumSystemVersion` keeps it unloaded.

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
  workflow; that workflow runs in GitHub's `release` environment, the same one
  the build ran in — so publishing is the trigger and the environment's
  approval is the second gate — and then copies artifacts onto the stable
  keys, feed last, because writing `latest-mac.yml` is the ship moment. `just
  promote` is the manual equivalent. Trust comes from the sha512 in the feed
  plus the Developer ID signature; there is no Sparkle-style appcast key.
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
universal Camoufox tree — dropping the bundled Python removed ~374 MB of
payload and its thousands of signed files, but the browser still dominates the
artifact), so updates are large. Blockmap
differential downloads may soften this; shipping the browser runtime
out-of-band (it is already pinned by `runtime.lock.json`) is the eventual fix
if update size becomes a problem.

## 11c. Telemetry (PostHog)

Usage statistics and error reporting go to PostHog — the same product family
the Plow API server (`api/plow/analytics.py` in the plow repo) and the plow.co
pages already report to — via `posthog-node` in the Electron **main process
only**. The sandboxed renderer stays network-silent and the CSP untouched;
`apps/desktop/src/telemetry.ts` is the one outbound funnel.

Decisions and their reasons:

- **The audit log is the source of usage events.** Telemetry taps
  `AuditLog`'s `recorded` emission rather than adding capture calls all over,
  so "what happened" has one spelling. An explicit **allowlist** in
  `telemetry.ts` decides which events and which fields leave the Mac; an event
  or field not named there is never sent, including every future one. Paths,
  argv, goal text, agent display names, intent ids and vault item
  ids/origins/titles are deliberately absent; the opaque server-minted agent
  id may ride, for per-agent counts.
- **Error reports carry no free-form text.** An error's message can embed
  anything the throwing code interpolated (a vault item's site, an otpauth
  parameter, a path), and no scrubber can enumerate what it doesn't know — so
  the message never leaves. What leaves is the error's name — only if it is
  a built-in one (`Error.name` is writable text, so anything else reports as
  "Error") — and its stack frames, in a `$exception` payload `trackError`
  **builds itself** — never the SDK's `captureException`, whose node
  entrypoint reads the local files named in stack frames and attaches
  surrounding source lines after any sanitising. A frame must match the full
  V8 `file:line:col` shape, after the stack's message region is cut off by
  exact prefix (a multiline message puts free-form text on `at`-shaped lines
  of its own); what matches is still scrubbed of the credential and the home
  path, and what doesn't is dropped, never shipped verbatim.
  `uncaughtExceptionMonitor` observes crashes without altering what Electron
  does with them.
- **A fatal crash spools its report to disk first** (synchronously, to
  `app/crash-report.json`), because the process usually exits before an async
  send completes; the spool is deleted only when an ORDERED send resolves
  (`sendNow` — not capture-then-flush, which can flush an empty queue before
  the SDK's async prepare enqueues the event and falsely report it safe), and
  a spool that outlives its process is reported by the next launch — which
  keeps the file until its own send resolves, so an offline launch retries
  rather than losing the report (only a spool that will not parse is deleted
  unsent). The
  quit-path flush is bounded (2s, not the SDK's 30s default) so an offline
  Mac never looks like an app refusing to quit.
- **`posthog-node` is pinned exactly** (5.21.2, no caret): 5.22.0 narrowed
  its Node engines past what Electron embeds (Node 20.18 in Electron 33), so
  a caret would drift the packaged app onto an unsupported runtime. Revisit
  the pin when Electron's Node crosses 20.20/22.22.
- **Only the packaged install reports** — same `app.isPackaged` gate as
  updates (§11b), so worktree runs and the test suite pollute nothing. The
  project key is baked into `telemetry.ts` like the API base URL (a PostHog
  project key is not a secret; plow.co ships one in HTML), with
  `DOMO_POSTHOG_KEY`/`DOMO_POSTHOG_HOST` env overrides for pointing a build at
  a scratch project.
- **The owner can turn it off**: `telemetryEnabled` in settings (default on),
  a toggle in the Settings tab's Privacy section, honored on the next event
  with no relaunch.
- **The distinct id is the signed-in account uid** — the same keying the Plow
  API server uses, so one person's server and desktop events line up — else an
  anonymous per-install UUID persisted beside `settings.json`.

## 12. Roadmap

1. **v1 (this repo, now):** everything above, local, tested.
2. **v1.x:** Noise channel over loopback; Keychain/SE device key; rules
   management UI polish; `(trace)` dry-run preview; tighter `mach-lookup`.
3. **Remote:** cloud broker (same wire contract), WebSocket transport, pairing
   codes, revocation; iOS approval app.
4. **Multi-user:** spaces, capability ceilings, cross-owner approvals.
5. **Adversarial reviewer** — *landed*, though not as planned here: it sits
   between policy and prompt as an additional gate, but judges the one intent
   in front of it rather than consuming the audit stream (§4).
   `apps/desktop/src/adversarialAgent.ts`, wired into the approval path at
   `main.ts`.

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

**What landed** (as of the migration; see #137 — parts of this list describe
components since removed)**:**
- `packages/{protocol,transport,broker-core,device-core}` + `apps/{broker,mcp,device,desktop}`.
- `fixtures/*.json` golden vectors, asserted by the TS suite. Generated by the
  Swift implementation during the migration; now frozen (the generator is
  gone). The key-schedule, AEAD-frame and connection-string vectors listed here
  originally went with the concepts they froze — `README-ts.md` has the six
  that remain.
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
