# Domo — Design Document

**Status:** v1 (local loop) — decisions locked 2026-08-08
**Audience:** Domo developers and agents working on this codebase.

Domo lets a remote AI agent (Claude Code or any MCP-speaking agent) use a person's
Mac — read and write files, run CLI commands with streaming output, and invoke
"blessed" tools built for our applications — through an **intent-based request
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

One MCP endpoint (the broker), device-addressed tools. Agents connect once and
reach every Mac they hold grants for. Claude Code connects via the `domo-mcp`
stdio shim (auth token + socket path via env; pure pipe thereafter).

| Tool | Purpose |
|---|---|
| `list_devices()` | Devices visible to this agent: id, name, online, granted |
| `request_device_access(device, goals)` | Ask the owner for access |
| `read_file(device, path, goal?)` | Read a file (returned base64 for binary safety) |
| `write_file(device, path, content, goal?)` | Write a file |
| `run_command(device, argv, cwd?, read_paths?, write_paths?, network?, wait_ms?, goal?)` | Run a CLI command in the sandbox; returns full output or a handle |
| `get_output(device, handle, since?)` | Incremental output of a running command |
| `list_device_tools(device)` | That Mac's blessed tools with JSON schemas |
| `use_tool(device, tool, args, goal?)` | Invoke a blessed tool |

Design points:

- **Blessed tools are per-device and discovered dynamically** via
  `list_device_tools` rather than flattened into the global MCP tool list —
  different Macs have different tools, and devices come and go mid-session.
- **Streaming:** MCP tool calls are request/response, so `run_command` waits up
  to `wait_ms` (default 10 s); if the command is still running it returns a
  `handle` plus output-so-far, and the agent polls `get_output(handle, since)`
  for incremental bytes. stdout and stderr are merged into one stream.
- **`goal`:** each mutating tool accepts an optional goal/justification string,
  displayed to the approver. Session-level goals (from the access request or
  spin-up) become the intent's `plan_context`.
- **Network default:** `run_command` denies network unless `network: true` was
  explicitly declared (and therefore approved).

## 4. The intent object

Every operation (file read/write, command, blessed tool) becomes one signed
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

**Minimize what needs sandboxing.** `read_file`, `write_file`, and blessed
tools execute *in-process* in the device app — trusted code, bounds-checked
against the approved paths (canonicalized, symlink- and `..`-safe), inherently
audited. Only `run_command` runs third-party code, and only it gets the cage.

**Seatbelt (`sandbox-exec`) with a generated profile.** The profile is not
authored by anyone — it is *mechanically derived* from the approved capability
set:

- `(deny default)` base + boilerplate any process needs (dyld, `/usr`,
  `/System`, `/dev/null`, sysctl-read, …)
- `file-read*` on approved read paths (`subpath`), plus `cwd`
- `file-write*` on approved write paths + a private scratch dir (`TMPDIR`/`HOME`
  point there)
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

## 9. On-disk layout

```
$DOMO_HOME (default ~/Library/Application Support/Domo)
├── run/agent.sock, run/device.sock      # 0700 dir
├── broker/agents.json                   # agent identities, tokens, grants
├── broker/devices.json                  # enrolled devices
├── device/identity.json                 # device keypair
├── device/known_agents.json             # pinned agent pubkeys
├── device/rules.json                    # always-allow rules
├── device/audit.ndjson                  # append-only audit log
├── device/goals.json                    # goals library
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
  `get_output` → blessed tools → always-allow rule reuse (asserted via audit
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

## 12. Roadmap

1. **v1 (this repo, now):** everything above, local, tested.
2. **v1.x:** Noise channel over loopback; Keychain/SE device key; rules
   management UI polish; `(trace)` dry-run preview; tighter `mach-lookup`.
3. **Remote:** cloud broker (same wire contract), WebSocket transport, pairing
   codes, revocation; iOS approval app.
4. **Multi-user:** spaces, capability ceilings, cross-owner approvals.
5. **Adversarial reviewer:** an agent consuming the same intent + audit stream,
   sitting between policy and prompt as an additional gate.
