# Domo Desktop

Lets a remote AI agent (Claude Code or any MCP client) use a Mac — read/write
files, run CLI commands with streaming output, and invoke "blessed" tools —
through an **intent-based approval system**. Every operation becomes a
structured intent that a human approves before it runs inside an on-the-fly
seatbelt sandbox scoped to exactly the approved capabilities.

Implemented in **TypeScript** (Node + Electron). See [DESIGN.md](DESIGN.md) for
the architecture and [README-ts.md](README-ts.md) for the package/app layout.

> **Being rebuilt — no agent can reach this Mac today.** The in-repo broker that
> used to route agents here has been removed. A Mac will instead dial *out* to
> the Plow relay, which authenticates the calling agent and forwards MCP to an
> MCP server running in this app. That MCP server and the outbound relay client
> are the next pieces of work. What is here now — the policy engine, the
> capability-derived sandbox, file operations, the audit log, the approval UI and
> the adversarial reviewer — builds, runs and is covered by the test suite, but
> has no transport in front of it.

## Quickstart with `just`

The `justfile` wraps every workflow behind named recipes. Run `just` with no
arguments to list them. Requires Node LTS and
[`just`](https://github.com/casey/just) (`brew install just`).

```sh
just install     # install workspace deps (first time)
just test        # the test suite
just app         # launch the desktop app
```

## Components

| App / package | Role |
|---|---|
| `apps/desktop` (Domo Desktop) | Electron app: runs the device core in its main process; approval windows, Goals Library, rules manager, audit viewer. |
| `packages/protocol` | Canonical JSON, Ed25519 identity, capabilities, intents, grants, rule keys. |
| `packages/transport` | The Connection seam and the outbound WebSocket client. |
| `packages/device-core` | The decision + execution path: policy engine, sandboxed executor, file ops, blessed tools, audit log. |

## Security posture

Intents carry a nonce and an expiry and are decided against stored always-allow
rules keyed on the exact normalized capability set — never on goal text.
Commands are sandboxed with per-invocation seatbelt profiles derived from the
approved capabilities. The audit log is append-only. See DESIGN.md §8.

Agent identity used to be an agent-held Ed25519 key pinned at access-grant time;
it will instead be asserted by the relay, which authenticates the agent before
forwarding. Note two things that are true of the code today: the device private
key is a plaintext seed in a `0600` file (there is no Keychain or `safeStorage`
integration anywhere), and `settings.json` — which holds an Anthropic API key —
is written with no explicit mode.
