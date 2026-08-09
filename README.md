# Domo Desktop

Lets a remote AI agent (Claude Code or any MCP client) use a Mac — read/write
files, run CLI commands with streaming output, and invoke "blessed" tools —
through an **intent-based approval system**. Every operation becomes a
structured, signed intent that a human approves before it runs inside an
on-the-fly seatbelt sandbox scoped to exactly the approved capabilities.

See [DESIGN.md](DESIGN.md) for the full architecture and the reasoning behind
each decision. This is the v1 local loop: everything runs on one Mac, but every
flow uses the same protocol a remote deployment will.

## Quickstart with `just`

The `justfile` wraps every workflow — build, test, and a full local stack —
behind named recipes. Run `just` with no arguments to list them.

```sh
just            # list all recipes
just test       # full test suite (unit + full-stack E2E), ~5s
just demo       # build, start a local stack, and run one end-to-end session
just run /bin/echo hi     # run any command on the device through the full stack
just claude-add # register the running stack with Claude Code
just app        # launch the AppKit app (real approval dialogs)
just down       # stop the local stack;  just clean  also deletes its home
```

`just demo` is the fastest way to *see* the system work: it stands up a broker
and an auto-approving headless device, mints an agent, grants access, runs a
sandboxed command, and prints the audit trail — all in a couple of seconds.

Requires Swift 5.10+ / macOS 13+ and [`just`](https://github.com/casey/just)
(`brew install just`). A `Makefile` mirrors the core build/test targets if you
prefer `make`.

## Components

| Binary | Role |
|---|---|
| `domo-broker` | Local rendezvous service: device registry, agent identities/grants, message routing, MCP endpoint. Stands in for the future cloud broker. |
| `domo-device` | Headless device runner — same core as the app, with a scripted policy instead of dialogs. Used for automated testing. |
| `domo-mcp` | stdio↔socket MCP shim so Claude Code can connect. |
| `DomoApp` | AppKit menu-bar app: approval dialogs, Goals Library + agent spin-up, rules manager, audit log viewer. |

## Try it with Claude Code

```sh
just claude-add     # starts the stack (if needed) and registers MCP server "domo"
```

Then in a Claude Code session, ask it to `list_devices`,
`request_device_access`, and go from there. `just claude-add` prints the exact
`claude mcp add` command it ran in case you want to inspect or repeat it.

In real use the device is `DomoApp`, which prompts a human for every intent
(Allow Once / Always Allow / Deny). Launch it with `just app`, which starts the
broker as a **separate** process and points the app at it via `--broker-socket`
(the app connects to a broker but never launches one). Run a broker yourself
with `just broker`; stop the app + its broker with `just app-down`.

For the underlying binaries and flags (if you want to run without `just`), see
the recipe bodies in the `justfile`.

## Agent tool surface (MCP)

`list_devices`, `request_device_access`, `read_file`, `write_file`,
`run_command`, `get_output` (streaming), `list_device_tools`, `use_tool`. All
device-addressed, so one agent connection reaches every Mac it holds a grant
for. See DESIGN.md §3.

## Security posture (v1)

Ed25519-signed intents with nonce + expiry; agent keys pinned at access-grant
time; commands sandboxed with per-invocation seatbelt profiles derived from the
approved capabilities; append-only audit log. Deliberate v1 gaps (loopback
without channel encryption, TOFU key pinning, broker-held agent keys) and their
remote-milestone fixes are documented in DESIGN.md §8.
