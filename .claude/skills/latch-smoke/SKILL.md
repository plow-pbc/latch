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
bearer token. It is minted once, in the app's Agents tab on the target Mac
(a GUI step), and then **recorded at a known path so no later run needs the
GUI**: save the block `_mcpConfig` renders, verbatim, to
`~/.latch/<install>.json` — `0600`, directory `0700`, one file per install
(`docs/AUTONOMOUS-OPERATION.md` Stop 3 owns this convention). The block:

```json
{"mcpServers":{"plow":{"type":"http","url":"<mcpUrl>","headers":{"Authorization":"Bearer <token>"}}}}
```

Pass it as `--config ~/.latch/<install>.json`, which supplies both url and
token; `--url` + `--token-file` (token alone, one line, `0600`) remains for a
credential that is not recorded. Treat the file the way this repo treats every
credential: never echo it, never put it in a log line or a commit, reference
the token by its last 3 characters only. The script prints an HTTP status on
a refusal and never the response body, because an authenticated response can
repeat the credential back.

## Run it

```bash
scripts/latch-smoke --config ~/.latch/<install>.json \
  --home "~/Library/Application Support/Plow-Latch"
```

- `--home <dir>` — **required.** The instance home to read. There is no
  default: every wrong home this script has produced came from it choosing
  one, and a chosen home that is wrong reads as a fresh install rather than as
  an error.

  ```bash
  --home "~/Library/Application Support/Plow-Latch"   # a packaged install
  --home "$(just --evaluate apphome)"                 # from source
  ```

  Evaluate `apphome` **from the same checkout and the same shell environment
  `just app` saw** — `branch` comes from `scripts/worktree-name.sh`, so it
  follows the checkout, and the `-local` suffix follows `DOMO_API_BASE_URL`.
  From a different worktree, or with that variable unset when the app had it,
  the answer is a different install. If in doubt, use the `DOMO_HOME=` value
  `just app` echoes in its recipe line.

  Do not build that path by hand. `justfile:28` picks between three homes and
  the one people forget is the local-relay `Plow-Latch-<branch>-local`, which
  exists so a credential minted against one relay never lands in the other's
  home.

  A wrong home is the usual cause of a `TIMEOUT` that found nothing, which is
  why the run prints `home=` and refuses one that does not exist — on either
  side of `--ssh`.

- `--ssh <user@host>` — read that Mac's audit log over ssh instead of this
  one's. Host map: the `tailscale-ssh` skill. The call itself always goes over
  the relay, so only the log read is remote.
- `--timeout <seconds>` — default 120, and must be **more than 2**: the log
  read always consumes some of it, so at or below that a call has no time to
  answer and the script says so rather than sending. One deadline covers the
  log read, the send and every poll, rather than starting after the send: a
  relay that accepts and never answers costs roughly what you asked for
  instead of the 90 seconds a hard-coded socket timeout used to spend. It is a
  bound on each blocking wait, not a wall-clock guarantee — `urlopen`'s
  timeout is per socket operation, so name resolution is outside it and a
  trickled response body resets it — and every log read is allowed 5s even
  past the deadline, so a timed-out run reports its real verdict rather than
  an unreadable log.
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
| `REFUSED — HTTP 3xx` | 1 | the relay tried to redirect and this follows none — `urllib` carries the bearer across a redirect, so following one would hand it to wherever it pointed. Check `--url` |
| `REFUSED — HTTP 4xx` | 1 | refused before an intent existed, so there is no audit line. 401/403 is the relay or the credential; another 4xx is the MCP handler |
| `UNVERIFIED — …` | — | not an outcome. The send did not settle the question: anything that is not a response (a timeout, a dropped socket), a 5xx, or an `isError` — which is also how an ordinary **denial** comes back. So the script does not stop; it polls (up to 20s to see it arrive, then the rest of the window), and one of the rows above is still the answer |
| `TIMEOUT — … approval dialog` | 1 | it arrived and is sitting unanswered. Not a plumbing problem |
| `TIMEOUT — approved, never started` | 1 | `exec_start` is written before the spawn, so its absence means the executor was never reached. Check the app is running |
| `TIMEOUT — started, still running` | 1 | re-run, or raise `--timeout` |
| `TIMEOUT — nothing carrying …` | 1 | it never arrived; the output names the three causes |
| `TIMEOUT — the audit log stopped being readable` | 1 | the call WAS sent — re-read the log for the nonce once the host is reachable |
| `REFUSED — the relay answered with a JSON-RPC error` | 1 | refused before it became an intent; nothing was written to the log. A bad envelope or an unknown tool. The relay's own text is deliberately **not** quoted — that response is authenticated and can reflect the credential back — so read the relay's logs for the detail |
| `REFUSED — could not reach <url>` | 1 | the request never left this Mac — a URL with no scheme is rejected before any socket exists. Check `--url`; the message quotes what was wrong with it |
| `REFUSED — <file> has a line break inside the token` | 1 | nothing was sent. A token pasted across two lines keeps its newline, and the header it would build is refused — rewrite the file as a single line |
| `REFUSED — cannot read the audit log` | 1 | nothing was sent, deliberately: a call this cannot verify would still raise a dialog. Check `--ssh`, and that `--home` is readable — a *missing* log is not this |

## Smoke-testing the gog provider specifically

gog is vendored on `main` (plow-pbc/latch#183). A build has it on the agent's
PATH; a from-source checkout needs `just fetch-gog` first. The mint also needs
`gmail:access-token` in the device's scopes, which is plow-pbc/plow#1416 and is
not landed — until it is, this section's commands reach gog and fail at the
mint, not at the binary.

Same command, its own argv:

```bash
scripts/latch-smoke --config ~/.latch/<install>.json \
  --home "~/Library/Application Support/Plow-Latch" -- gog gmail search newer_than:1d --json
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
- `UNVERIFIED — …` → not a result. **Read the row the script lands on
  afterwards, not this line** — the table above says which outputs those are
  and what waiting it does. The only thing worth adding here: this is the one
  prefix that is not a verdict, so treating it as one is the mistake to avoid.
- `TIMEOUT — nothing carrying …` → the three causes the output names, in
  likelihood order: a **different** install's log (check `--home`; a
  branch-suffixed home is the usual cause), a refusal in the MCP layer before
  an intent existed, or a `validate` rejection — wrong device, expired,
  replayed nonce — which writes `intent_rejected` *without* the nonce, so the
  script quotes any written since the send.
- Approval dialog never answered → expected on an unattended run; see above.
