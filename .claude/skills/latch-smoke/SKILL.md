---
name: latch-smoke
description: Prove an installed Latch actually works, by driving one real MCP call through the relay and reading the result out of audit.ndjson. Use after installing a build, after any change to the relay client, the MCP server or the exec path, or when someone asks whether a Mac is reachable. Works against the local install or any SSH-reachable one.
---

# Latch smoke — one real call, verified in the audit log

The unit suite never opens a socket to a real relay (`README-ts.md`
§ Integration coverage). This is the leg that does: an MCP client → the Plow
relay → the device WebSocket → `@domo/mcp-server` → the executor.

**The audit log is the proof, not the client's reply.** A reply can come from a
deferred handle or a half-working path; an `exec_end` carrying this call's
intent id cannot.

One command does it: `scripts/latch-smoke`. It sends and then verifies in the
same process, so there is no state to copy between steps. Its outcome table
lives in a pure `verdict()` and is covered by `e2e/latchSmoke.test.ts` — read
that file to see exactly which records produce which exit code.

## Before you start: the credential

You need an MCP client registration for the target install — endpoint plus
bearer token. **This is not recorded anywhere an unattended run can read**,
which is Stop 3 in `docs/AUTONOMOUS-OPERATION.md`. Today it comes from the
app's Agents tab on the target Mac, which is a GUI step.

It looks like the block `_mcpConfig` renders:

```json
{"mcpServers":{"plow":{"type":"http","url":"<mcpUrl>","headers":{"Authorization":"Bearer <token>"}}}}
```

Put the token in a `0600` file and pass the path. Treat it the way this repo
treats every credential: never echo it, never put it in a log line or a commit,
reference it by its last 3 characters only. The script prints an HTTP status on
a refusal and never the response body, because an authenticated response can
repeat the credential back.

## Run it

```bash
scripts/latch-smoke --url <mcpUrl> --token-file <path>
```

- `--home <dir>` — the instance home, if it is not the packaged default
  `~/Library/Application Support/Plow-Latch`. A from-source run is
  `Plow-Latch-<branch>` (`scripts/worktree-name.sh --branch`); a wrong home
  here is the usual cause of a `TIMEOUT` that found nothing.
- `--ssh <user@host>` — read that Mac's audit log over ssh instead of this
  one's. Host map: the `tailscale-ssh` skill. The call itself always goes over
  the relay, so only the log read is remote.
- `--timeout <seconds>` — default 120.
- Everything after `--` replaces the command. The default is a **fixed**
  `/bin/echo latch-smoke`, and that is deliberate: the run's nonce rides `goal`,
  which `RuleKey.compute` excludes from the rule key, so one pre-seeded Always
  Allow rule matches every run. A nonce in the argv would mint a new key each
  time and raise a dialog forever.

**Without such a rule this raises an approval dialog on the target Mac.** That
is the product working, not a failure — but a fully unattended smoke needs
either a pre-seeded rule or `HeadlessPolicy`, and no shipped app exposes the
latter. Say so in the report rather than waiting on a dialog nobody is watching.

## Reading the result

Only success exits 0.

| Output | Exit | Means |
|---|---|---|
| `OK` + `exec_start`/`exec_end` | 0 | it worked — quote both lines as the verification |
| `FAILED — it ran and …` | 1 | it executed and exited nonzero, or this Mac reaped it. Not a plumbing fault |
| `FAILED — the executor threw` | 1 | `exec_error` names why; nothing ran |
| `DENIED` | 1 | the owner refused it. The relay and the device both worked |
| `REFUSED — HTTP 4xx` | 1 | refused before an intent existed, so there is no audit line. 401/403 is the relay or the credential; another 4xx is the MCP handler |
| `UNVERIFIED — …` | — | not an outcome. **Anything that is not a response** — a 5xx, a timeout, a dropped socket, a malformed URL — leaves the call's fate unknown, so the script does not stop; it polls (20s to see it arrive, then the full window), and one of the rows above is still the answer |
| `TIMEOUT — … approval dialog` | 1 | it arrived and is sitting unanswered. Not a plumbing problem |
| `TIMEOUT — approved, never started` | 1 | `exec_start` is written before the spawn, so its absence means the executor was never reached. Check the app is running |
| `TIMEOUT — started, still running` | 1 | re-run, or raise `--timeout` |
| `TIMEOUT — nothing carrying …` | 1 | it never arrived; the output names the three causes |
| `TIMEOUT — the audit log stopped being readable` | 1 | the call WAS sent — re-read the log for the nonce once the host is reachable |
| `REFUSED — cannot read the audit log` | 1 | nothing was sent, deliberately: a call this cannot verify would still raise a dialog. Check `--ssh`, and that `--home` is readable — a *missing* log is not this |

## Smoke-testing the gog provider specifically

> **Depends on plow-pbc/latch#183**, which vendors gog and adds `just fetch-gog`.
> Until that merges there is no `gog` on any install's PATH.

Same command, its own argv — and it needs `gog` staged and `gmail:access-token`
in the device's scopes:

```bash
scripts/latch-smoke --url <mcpUrl> --token-file <path> -- gog gmail search newer_than:1d --json
```

Three things distinguish a working provider path from a broken one, all visible
without touching Google:

| Output | Means |
|---|---|
| `FAILED — the executor threw` … `not installed` | no vendored binary — run `just fetch-gog` and repackage |
| `FAILED — the executor threw` … `could not reach Plow` / `returned 4xx` | the mint failed; check the device credential's scopes |
| `OK` | the whole path works |

A `403` *inside* gog's own output is not a Latch failure — the token carries
four Google scopes and refuses everything else by design.

## Failure triage

- `REFUSED — HTTP 401/403` → the credential is wrong or the device was
  re-paired. Scopes freeze at mint; a Mac paired before a scope grant needs to
  re-activate.
- `UNVERIFIED — …` → the send did not come back with a response, so whether an
  intent exists is not something to guess at: the relay can abandon an exchange
  it has already forwarded (`RELAY_TIMEOUT_MS` is 25s, well under the
  executor's budget) either as a 5xx or by dropping the socket, and a bad
  `--url` looks the same from here. The script reads the log instead — 20s for
  an `intent_received` to appear, then the full window. Read the row it lands
  on, not this line.
- `TIMEOUT — nothing carrying …` → the three causes the output names, in
  likelihood order: a **different** install's log (check `--home`; a
  branch-suffixed home is the usual cause), a refusal in the MCP layer before
  an intent existed, or a `validate` rejection — wrong device, expired,
  replayed nonce — which writes `intent_rejected` *without* the nonce, so the
  script quotes any written since the send.
- Approval dialog never answered → expected on an unattended run; see above.
