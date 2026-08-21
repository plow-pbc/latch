# Plow Latch

Lets a remote AI agent (Claude Code or any MCP client) use a Mac — read/write
files, run CLI commands with streaming output, and drive a real browser —
through an **intent-based approval system**. Every operation becomes a
structured intent that a human approves before it runs inside an on-the-fly
seatbelt sandbox derived from the approved capabilities. Note what that does and
does not mean: the profile is *built from* those capabilities, but it is not a
tight fit around them — reads in particular are permitted more broadly. See
[docs/SANDBOX-BOUNDARY.md](docs/SANDBOX-BOUNDARY.md).

Implemented in **TypeScript** (Node + Electron). See [DESIGN.md](DESIGN.md) for
the architecture and [README-ts.md](README-ts.md) for the package/app layout.

**The product is Plow Latch; the codebase is `domo`.** The app ships, launches and
brands itself as Plow Latch. `domo` survives in the identifiers a rename must not
touch — the bundle id, the update-feed prefix, the `@domo/*` package scope,
`DOMO_HOME`, this repository's name, and the frozen vault Keychain identity
(DESIGN.md §11a-i, which records what renaming it cost the last time).

> **Being rebuilt.** The in-repo broker that used to route agents here has been
> removed. A Mac now dials *out* to the Plow relay, which authenticates the
> calling agent and forwards MCP to an MCP server running in this app. Both
> halves exist here — that server and the outbound relay client — and so does
> the relay itself (see `CLAUDE.md` § Layout, "Being rebuilt").
> **Agents do reach this Mac today.** The policy engine, the capability-derived
> sandbox, file operations, the audit log, the approval UI and the adversarial
> reviewer build, run and are covered by the test suite. What the relay leg's
> automated coverage does and does not reach is owned by
> [README-ts.md](README-ts.md#integration-coverage) § Integration coverage;
> the rest of that leg is verified by hand.

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
| `apps/desktop` (Plow Latch) | Electron app: runs the device core in its main process; approval windows, rules manager, audit viewer. |
| `packages/protocol` | Canonical JSON, Ed25519 identity, capabilities, intents, grants, rule keys. |
| `packages/transport` | The Connection seam and the outbound WebSocket client. |
| `packages/device-core` | The decision + execution path: policy engine, sandboxed executor, file ops, browsing subsystem, audit log. |

## Security posture

Intents carry a nonce and an expiry and are decided against stored always-allow
rules keyed on the exact normalized capability set — never on goal text.
Commands are sandboxed with per-invocation seatbelt profiles derived from the
approved capabilities — *derived from*, not tightly fitted to; see
[docs/SANDBOX-BOUNDARY.md](docs/SANDBOX-BOUNDARY.md) for what the profile
actually permits. The audit log is append-only. See DESIGN.md §8.

Agent identity used to be an agent-held Ed25519 key pinned at access-grant time;
it will instead be asserted by the relay, which authenticates the agent before
forwarding. Note two things that are true of the code today: the device private
key is a plaintext seed in a `0600` file (there is no Keychain or `safeStorage`
integration anywhere), and `settings.json` — which holds the Plow relay
credential — is written `0600`.
