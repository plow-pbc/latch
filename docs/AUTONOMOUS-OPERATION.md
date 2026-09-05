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

All four are further along than they look. Building a signed artifact is
automatable **for `main`** — this repo ships the CI workflow that does it —
and driving a call and reading the log are `scripts/latch-smoke`.

**One real gap** remains, and it is the whole of what is worth building:
nothing installs a built artifact onto a target Mac (Stop 2). Addressing an
install as a client (Stop 3) now has an interim answer — the recorded
registration at `~/.latch/<agent>.json` — with only its one-time mint
still a GUI step.

**Three deliberate gates** are not gaps and should stay: the `release`
environment's approval before a signing runner starts, publishing the draft,
and approving the promotion that publishing fires — those last two are separate
decisions, not one.

Building an *unmerged* branch is the one place the local-keychain wall is still
real, and it is a consequence of the workflow being `main`-only rather than a
gap of its own.

---

## Stop 1 — getting a signed build onto a target (partly solved)

Signing is **not** the wall it looks like from a shell. `just package` does need
the Plow Developer ID in the login keychain, and over SSH that keychain is
audit-session-scoped — a non-interactive session cannot unlock it, so a local
`codesign` fails however the recipe is invoked. But this repo already ships the
answer, a port of plow's: `.github/workflows/build-release-candidate.yml` runs
on `macos-26`, signs and notarizes in the runner's own keychain, uploads
versioned artifacts to S3 and opens a **draft** GitHub release. No local
keychain, no FDA, dispatchable over SSH.

What actually stops an unattended run is narrower than "no workflow", and each
piece is worth naming separately:

1. **It builds any branch.** Dispatch it on a feature branch and it drafts a
   *prerelease* whose title names the branch; `promote-app.yml` refuses
   prereleases, so publishing one cannot reach installed apps. The `release`
   environment's deployment branch policy has to admit the branch (all
   branches, or a pattern) or GitHub rejects the dispatch before any step runs.
2. **The `release` environment has required reviewers**, deliberately: with the
   branch policy open, the reviewers are what keep a dispatch from an arbitrary
   branch away from the signing secret. A human approves the deployment before
   the runner starts.
3. **Publishing the draft is a human gate** by design — it fires
   `promote-app.yml`. Note that publishing is not itself the moment installed
   apps begin updating: `promote-app.yml` also runs `environment: release`, so
   it waits for a SECOND approval before copying anything onto the stable keys.
   Two gates, not one, and an operator who publishes and walks away leaves the
   promotion pending indefinitely. Both should stay.
4. **Nothing installs the result.** There is no `install-latest-*` script that
   resolves the newest artifact and puts it on a target Mac; plow's
   `plow-prod-install-auto` skill has that half. This is the piece worth
   building, and it is small next to the workflow that already exists.

So the hand-off here is not "go build it by hand", merged or not:

> Dispatch `build-release-candidate.yml` from the branch (`main` for a real
> candidate), approve the `release` environment when GitHub asks, then install
> the notarized DMG on the target.

The local route still exists: `just package` from any checkout on a Mac with
the signing keychain unlocked, which is where the keychain wall is real.
`just package-unnotarized` needs the same keychain, so it does not lift this,
and it produces an artifact Gatekeeper refuses on any other machine, so it is a
local-check build only.

## Stop 2 — installing on the target (a real gap)

`ditto`ing an app bundle over `/Applications` needs no GUI. Quitting a running
Latch does not either. And the artifact already exists: Stop 1's workflow
notarizes one and uploads it. What is missing is the script that resolves the
newest one and puts it on a target — see plow's
`scripts/plow-install/install-latest-production-build.sh` for the shape,
including the graceful-quit-then-escalate window.

What is genuinely irreducible here is **first-run consent**: a fresh install
signs in for its own relay credential, and Latch's own docs are explicit that
`settings.json` must never be copied between homes because the relay does not
support two devices on one credential. So a *first* install on a new Mac has a
one-time interactive step. A *re-install over an existing one* does not — the
home survives, and that is the case an unattended run actually wants.

## Stop 3 — addressing an install as a client (interim fix in place: the recorded registration)

To smoke-test an install you need to be the agent: an MCP client pointed at the
relay, carrying a credential the relay accepts for this device.

**The app records that configuration nowhere.** Searched on the production Mac:
`~/Library/Application Support/co.plow.app/` has `setup.json`, `plow-api-token`
and the agent runtime's per-plugin `.mcp.json` files — none of which mention the
relay MCP endpoint or a Latch device. Nothing under `agent-runtime/` matches
`relay/mcp`.

The app itself knows: `settings.json` holds `mcpUrl` (from `GET /v1/relay/info`,
server-authoritative — the app never constructs it) and `relayCredential`, and
the Agents tab renders a paste-ready client registration. But there is no
file an unattended run can read to reach an install it did not just create.

**The interim fix is in place**: the operator records the registration on
their own machines, the way `plow-message` reads a target's own
`plow-api-token` from a known path. The convention — one file per agent credential,
holding the `_mcpConfig` block the Agents tab renders, verbatim:

```
~/.latch/<agent>.json          # 0600, directory 0700
```

`scripts/latch-smoke --config ~/.latch/<agent>.json --server <name>` selects a
named Mac from a multi-device block, so an unattended run needs the GUI only once, at mint time. The
relay endpoint inside is not a secret; the bearer token is — the file never
gets echoed, committed, or copied into a checkout.

What would still improve it: a `latch mcp-config` style command that emits
that block from the app's own `settings.json`-adjacent state, so even the
mint-time GUI copy step disappears. Until then, minting a registration
remains the one GUI step; everything after it reads the recorded file.

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
- **sign and notarize a build of `main`**, by dispatching
  `build-release-candidate.yml` — a human approves the `release` environment,
  and nothing else about it needs a local keychain
- drive one real MCP call against an install and read the verdict out of its
  audit log, locally or over SSH: `scripts/latch-smoke` — **given a recorded
  client registration** (`--config ~/.latch/<agent>.json --server <name>`, Stop 3), whose
  mint is the one remaining GUI step
- read any install's `audit.ndjson` over SSH, given access to the host

That is most of the loop. What is left is the gap named at the top: **put a
built artifact onto a target Mac.** The signing wall is only a wall for an
unmerged branch, and the three reviewer gates are deliberate.
