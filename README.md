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

> **Agents reach this Mac today.** The in-repo broker that used to route them
> here has been removed. A Mac now dials *out* to the Plow relay, which
> authenticates the calling agent and forwards MCP to an MCP server running
> in this app. Both halves exist here — that server and the outbound relay
> client — and so does the relay itself (see `CLAUDE.md` § Layout, "Rebuilt:
> a Mac dials out"). So the policy engine, the capability-derived sandbox,
> file operations, the audit log, the approval UI and the adversarial
> reviewer are not just covered by the test suite: they are the live path a
> real caller drives. What the relay leg's automated coverage does and does
> not reach is owned by [README-ts.md](README-ts.md#integration-coverage) §
> Integration coverage; the rest of that leg is verified by hand.

## Where changes go

This repo is one of several that assemble a Plow agent. The map of which repo
owns what is in
[`plow-hermes-agent` README § The repos](https://github.com/plow-pbc/plow-hermes-agent#the-repos);
read it before a change that touches a neighbour. The test is **who else would
have to change if this fact changed** — if the answer is a sibling, the change
belongs there; this repo only follows, by bumping its pin if it holds one.

Not here:

- **The relay** — `plow-pbc/plow`, `api/plow/relay/`. It authenticates the
  calling agent and forwards MCP to this Mac. This repo owns the client that
  dials it (`packages/relay-client`, `wire.ts`) and the server it forwards to,
  not the relay.
- **Prompt framing of these tools** — `plow-pbc/hermes-plow-chat`, the
  `plow_chat` plugin: the section that tells a runtime dropping MCP
  `instructions` what the Mac tools are for. `SERVER_INSTRUCTIONS` here stays
  canonical; the plugin's section restates it for that one runtime, so a
  change to the wording here is a change to keep in step there.
- **Chat truth and the bounds on it** — `plow-pbc/plow`: the assistant name and
  its length bound, the daily payment cap, the roster. This Mac renders and
  edits them; plow stores and validates them.

Examples:

- Adherence — #301 changed the canonical `SERVER_INSTRUCTIONS` in
  `packages/mcp-server/src/handler.ts` and re-guarded every compressed
  restatement in `packages/mcp-server/test/toolCopy.test.ts`, so one asserter
  owns the sentence and a test fails when a copy drifts:
  https://github.com/plow-pbc/latch/pull/301
- Drift — #300 correctly writes the assistant name to plow
  (`PATCH /v1/api-keys/{id}/preferences`) and persists nothing Mac-side, but
  restates plow's 200-character bound in `apps/desktop/src/plowApi.ts`; that
  number is plow's, and this side should read it off the error:
  https://github.com/plow-pbc/latch/pull/300

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
it is now asserted by the relay, which authenticates the agent before
forwarding. Note two things that are true of the code today: the device private
key is a plaintext seed in a `0600` file, while the Plow relay credential is
`safeStorage`-sealed where available and falls back to plaintext in the
owner-only `0600` `settings.json`.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright 2026
The Plow Collective, Inc. The vendored `vendor/browser-server/` directory
carries its own MIT license from upstream. The browser fetched at package
time (`just package`; `just fetch-browser` covers dev) is Camoufox (MPL-2.0),
which is not part of this repository; its license governs redistribution of
packaged builds that bundle it. The fingerprint pool is sampled at build time
with camoufox-js (MPL-2.0), a build-only dependency that does not ship.

"Plow" and the Plow logo are trademarks of The Plow Collective, Inc. The
license grants no trademark rights.
