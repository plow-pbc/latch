# Domo Desktop

Lets a remote AI agent (Claude Code or any MCP client) use a Mac — read/write
files, run CLI commands with streaming output, and invoke "blessed" tools —
through an **intent-based approval system**. Every operation becomes a
structured, signed intent that a human approves before it runs inside an
on-the-fly seatbelt sandbox scoped to exactly the approved capabilities.

Implemented in **TypeScript** (Node + Electron). See [DESIGN.md](DESIGN.md) for
the architecture and the reasoning behind each decision, and
[README-ts.md](README-ts.md) for the package/app layout.

## Quickstart with `just`

The `justfile` wraps every workflow behind named recipes; the default flow is
networked (wss:// + certificate pin). Run `just` with no arguments to list them.
Requires Node LTS and [`just`](https://github.com/casey/just) (`brew install just`).

```sh
just install     # install workspace deps (first time)
just test        # full test suite (unit + golden vectors + full-stack E2E)

just broker      # terminal 1: the broker (wss, auto self-signed cert)
just app         # terminal 2: the desktop app, auto-wired to the broker
just agent "…"   # terminal 3: a Claude session that can drive the Mac
```

`just broker` prints the Broker URL + certificate pin (enter these in the app's
Settings) and a bundled connection string. For another machine to connect, pass
the broker's reachable address: `just broker 192.168.1.50`.

## Components

| Binary / app | Role |
|---|---|
| `apps/broker` (`domo-broker`) | Rendezvous service: device registry, agent identities/grants, message routing, MCP endpoint. The Linux hosting target. |
| `apps/device` (`domo-device`) | Headless device runner — same core as the app, with a scripted policy instead of dialogs. Used for automated testing. |
| `apps/mcp` (`domo-mcp`) | stdio↔broker MCP shim so Claude Code can connect. |
| `apps/desktop` (Domo Desktop) | Electron app: runs the device core in its main process; approval windows, Goals Library + agent spin-up, rules manager, audit viewer. |
| `packages/{protocol,transport,broker-core,device-core}` | Shared libraries: canonical JSON + Ed25519 + intents, the transport/E2E channel, and the broker/device cores. |

## Try it with Claude Code

```sh
just claude-add     # starts a broker (if needed) and registers MCP server "domo"
# or, throwaway session:  just agent "check my disk space"
```

Then in a Claude Code session, ask it to `list_devices`,
`request_device_access`, and go from there. In real use the device is the
Electron app, which prompts a human for every intent (Allow Once / Always Allow
/ Deny).

## Agent tool surface (MCP)

`list_devices`, `request_device_access`, `read_file`, `write_file`,
`run_command`, `get_output` (streaming), `list_device_tools`, `use_tool`. All
device-addressed, so one agent connection reaches every Mac it holds a grant
for. See DESIGN.md §3.

## Security posture

Ed25519-signed intents with nonce + expiry; agent keys pinned at access-grant
time; commands sandboxed with per-invocation seatbelt profiles derived from the
approved capabilities; append-only audit log; wss:// with SPKI certificate
pinning and an end-to-end encrypted agent↔device channel. See DESIGN.md §8.
