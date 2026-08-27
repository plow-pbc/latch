# Operating Latch unattended

What an agent can do to a Latch install without a human at the keyboard, what it
cannot, and what would have to change for each "cannot" to become a "can".

`docs/TESTING-THE-APP.md` covers verification of the *code*. This covers
verification of an *installed app* — the leg that starts after a build exists
and ends with a real MCP call arriving from a real relay.

Written after an unattended run tried to do the whole thing and stopped four
times. Each stop below is a real one, with what it actually costs.

---

## The shape of a full unattended run

```
build a signed artifact  →  install it on a target Mac  →  drive one real MCP call  →  read the audit log
```

Three of those four are automatable today. The first is not, and it is the one
that gates the rest.

---

## Stop 1 — the signed build (hard)

`just package` needs the Plow Developer ID in the login keychain and, for
notarization, a stored `notarytool` credential profile. Over SSH the login
keychain is **audit-session-scoped**: a non-interactive session cannot unlock
it, so `codesign` fails no matter how the recipe is invoked.

This is the same wall plow hit, and plow's answer is the pattern to copy:
`~/Hacking/plow3/.claude/skills/plow-prod-install-auto/SKILL.md` dispatches
`build-release-candidate.yml` so a **CI runner** signs and notarizes in its own
keychain, then installs the resulting notarized DMG. No local keychain, no FDA,
fully SSH-drivable.

**Latch has no equivalent workflow.** That is the single highest-leverage thing
to build for unattended operation: a `build-release-candidate`-shaped GitHub
Action that runs `just package`, and an `install-latest-*` script that resolves
the newest artifact and `ditto`s it over `/Applications/Plow Latch.app`.

Until that exists, every unattended run stops here and hands off:

> Run `just package` from the main checkout on a Mac with the signing keychain
> unlocked, then install the DMG on the target.

`just package-unnotarized` runs from any checkout and needs the same keychain,
so it does not lift this. It also produces an artifact Gatekeeper refuses on any
other machine, so it is a local-check build only.

## Stop 2 — installing on the target (soft, once Stop 1 is solved)

`ditto`ing an app bundle over `/Applications` needs no GUI. Quitting a running
Latch does not either. So this becomes automatable the moment a notarized
artifact can be produced without a human — see plow's
`scripts/plow-install/install-latest-production-build.sh` for the shape,
including the graceful-quit-then-escalate window.

What is genuinely irreducible here is **first-run consent**: a fresh install
signs in for its own relay credential, and Latch's own docs are explicit that
`settings.json` must never be copied between homes because the relay does not
support two devices on one credential. So a *first* install on a new Mac has a
one-time interactive step. A *re-install over an existing one* does not — the
home survives, and that is the case an unattended run actually wants.

## Stop 3 — driving a real MCP call (soft; the missing piece is written down nowhere)

To smoke-test an install you need to be the agent: an MCP client pointed at the
relay, carrying a credential the relay accepts for this device.

**That configuration is recorded nowhere.** Searched on the production Mac:
`~/Library/Application Support/co.plow.app/` has `setup.json`, `plow-api-token`
and the agent runtime's per-plugin `.mcp.json` files — none of which mention the
relay MCP endpoint or a Latch device. Nothing under `agent-runtime/` matches
`relay/mcp`.

The app itself knows: `settings.json` holds `mcpUrl` (from `GET /v1/relay/info`,
server-authoritative — the app never constructs it) and `relayCredential`, and
the Agents tab renders a paste-ready client registration. But there is no
file an unattended run can read to reach an install it did not just create.

**What would fix it**, in rough order of cost:

1. A `latch mcp-config` style command, or a documented path, that emits the
   `{mcpServers:{…}}` block the Agents tab already renders — so a smoke run can
   read it rather than screenshot a GUI. The relay endpoint is not a secret; the
   bearer token is, so this should print to stdout for capture, never to a log.
2. Failing that, record on the operator's own machine which credential reaches
   which install, the way `plow-message` reads a target's own
   `plow-api-token` from a known path.

Until one of those exists, an unattended smoke stops here.

## Stop 4 — reading the result (already automatable)

`audit.ndjson` under the instance home is append-only, one JSON object per line,
and is this repo's designated test oracle. A smoke run's proof is the
`exec_end` keyed to its own intent — `exec_start` is written before the spawn,
so on its own it proves only that the executor was reached. No GUI, no
screenshot. `scripts/latch-smoke` does the whole exchange; the `latch-smoke`
skill says how to read it.

---

## What an unattended run CAN do today, end to end

Everything up to the artifact:

- clone, install deps, `just build`, `npx vitest run`
- `just fetch-gog` and any other vendored runtime fetch — digest-verified, no keychain
- open a PR, iterate review, merge
- read any install's `audit.ndjson` over SSH, given access to the host

That is most of the loop. The gap is narrow and specific: **sign a build without
a human, and know how to address an install as a client.**
