# §8 final release gate — relay approval continuation and retry safety

Run 2026-08-19 by a QA cook against a **live local Plow stack** built from the
relay branch, with the desktop app running on the M4 in an **isolated checkout**.
No established worktree was switched; no product code was changed.

- **Desktop:** `codex` @ `5562be2` ("Retire an operation id when its deferred work lands").
- **Relay:** `plow` @ `d75153b3d` on `feat/relay-exchange-deadline-25s`
  (`/Users/plucas/plow-pbc/plow/relay-deadline`).
- **Old relay, for the mixed-version leg:** `plow` @ `83eca9b19` — the commit the
  branch is based on, checked out as a **new** worktree `relay-oldgate`.
- **Old desktop, for the other direction:** `codex` @ `abe1db3` — the last commit
  before Chunk 1, exported with `git archive` (no worktree, no branch switch).

## Where everything ran

| Piece | Where |
|---|---|
| New relay stack | Docker, variant `relaygate`, `https://api.plow-relaygate.orb.local` (host port 18914) |
| Old relay stack | Docker, variant `relayold`, `https://api.plow-relayold.orb.local` (host port 19134) |
| New desktop | `plucas-m4:~/plow-pbc/codex-relgate`, `DOMO_HOME=/tmp/domo-gate` |
| Old desktop | `plucas-m4:~/plow-pbc/olddesk-gate`, `DOMO_HOME=/tmp/domo-old` |
| New desktop vs old relay | `plucas-m4:~/plow-pbc/codex-relgate`, `DOMO_HOME=/tmp/domo-newold` |
| Agent (the caller) | This Mac, plain `curl` JSON-RPC POSTs to `/v1/relay/devices/{uid}/mcp` |

The M4 reaches the stacks through reverse ssh tunnels (`-R 18914:…`,
`-R 19134:…`), per the M4 wiki. Approval clicks are **real mouse events** through
CDP `Input.dispatchMouseEvent`; `Runtime.evaluate` only read text and bounding
rects, never `.click()`.

Device and agent credentials were minted by the **real** API
(`POST /v1/relay/devices`, `POST /v1/relay/agents`) on each stack. The device
credential was seeded into a throwaway `DOMO_HOME` rather than driven through the
activation wizard — onboarding is not what §8 gates, and the credential is the
genuine article either way.

---

## Headless suites

| Command | Where | Result |
|---|---|---|
| `npx vitest run` | this Mac, `codex` | **592 passed, 1 skipped, 45 files** |
| `npx vitest run` | M4, `codex-relgate` | **592 passed, 1 skipped, 45 files** |
| `uv run pytest tests/relay -q` (`TEST_DB_PORT=18913`) | `relay-deadline/api` | **113 passed** |

---

## Deliverable one — the live-stack gate

Every row below is one live call from the agent, through the relay, to the app on
the M4. Elapsed times are wall-clock at the caller.

| §8 requirement | What was run | Result |
|---|---|---|
| Shared timeout contract | app handshake against the new relay | `exchange deadline 25000ms, call budget 15000ms, direct ceiling 15000ms, response ack advertised` |
| Approval inside the measured inline window returns normally | `read_file`, approved at ~2.6 s | **2.64 s**, response carried `{"content":"the quarterly numbers"}` — not a handle. Window read `~14s left`. |
| Backgrounding after the deadline | `read_file`, left unanswered | **15.21 s**, response was `{"status":"pending","reason":"awaiting_approval"}` — inside the 25 s relay deadline. Window flipped to *"The agent stopped waiting on this call."* |
| The deferred response beats the relay deadline | same call | 15.21 s answered vs 25 s abandon: **9.8 s of margin**. |
| Approval after backgrounding | Allow Once clicked on the backgrounded window | Window collapsed to *"Approved — the result is ready and waiting."* |
| Result readiness | audit log | `continuation_result_ready` emitted at decision time |
| Result lookup | `get_result` by handle | `{"status":"ready","result":{"content":"the quarterly numbers"}}` |
| Exactly one agent-requested-result event | `get_result` called **3×** | `grep -c continuation_result_requested` = **1** |
| Denial, phase 1 (inline) | Deny clicked at 3.5 s | **3.51 s**, `{"status":"denied"}`, `isError: true`, on the original call |
| Denial, phase 2 (after backgrounding) | deferred, then Deny | handle at 15.29 s; `get_result` → `{"status":"denied","reason":"the owner of this Mac denied the request"}` |
| Result expiry | handle ready 21:01:00 UTC, polled every 60 s | `ready` through 21:15:22, **`expired` at 21:16:22** — the 15-minute TTL, live |
| Operation-id tombstone after expiry | `get_result` by id, then a full retry of the same id | both `{"status":"expired"}`; `intent_received` stayed at 7 — the expired id did **not** re-run |
| A late relay response is not mistaken for completion | socket dropped mid-call (see below) | relay answered the agent `{"detail":"Device did not respond in time"}` at 26.0 s; the app recorded `continuation_delivery_unknown` and the window said *"This Mac could not confirm the handoff"* — it claimed neither waiting nor handed off |

### Audit lifecycle, from the live run

```
intent_received → adversarial_review_started → adversarial_review_result
→ continuation_backgrounded → intent_decision → file_read
→ continuation_result_ready → continuation_result_requested
```

Totals over the whole session (`/tmp/domo-gate/device/audit.ndjson`):

```
7 intent_received   7 intent_decision   4 file_read   1 file_write
3 continuation_backgrounded   3 continuation_result_ready
4 continuation_result_requested   1 continuation_delivery_unknown
```

### Mixed-version rollout, both directions

| Direction | Handshake | Behavior |
|---|---|---|
| **New desktop → old relay** (`83eca9b19`, advertises nothing) | `exchange deadline 20000ms, call budget 8000ms, direct ceiling 15000ms, response ack unavailable` | Call deferred at **8.40 s** — the old budget retained. Window said *"This Mac could not confirm the handoff to your agent."* It did **not** falsely claim backgrounded, because no ack was advertised. |
| **Old desktop (`abe1db3`) → new relay** | `[relay] authenticated` — new fields ignored | Call deferred at **8.70 s**, exchange completed normally. `operation_id` was not required by that build and was not sent. Purely additive, as the relay commit claims. |

### Real Electron captures (M4)

The three continuation states from the approval-window fixture, and four from the
live run, are beside this file:

| File | State |
|---|---|
| `continuation-waiting-inline.png` | waiting inline, `~10s left` |
| `continuation-backgrounded.png` | backgrounded |
| `continuation-approved-uncollected.png` | approved, result uncollected |
| `live-A-waiting-inline.png` | **live**, waiting inline, `~14s left` |
| `live-B-backgrounded.png` | **live**, backgrounded by a real `relay.response.ack` |
| `live-B-approved-uncollected.png` | **live**, approved and uncollected, with Copy phrase |
| `live-mixed-old-relay.png` | **live**, delivery-unknown against the ack-less old relay |

`continuation-verify-rerun.json` is the 18-check `just continuation-verify` report
from this run (see the blocker below for the caveat on it).

---

## Deliverable two — retry safety, live

The scripted §6 case, driven for real: the reverse ssh tunnel was killed while an
approval was on screen, which drops the relay socket before the response can be
delivered.

1. `write_file` (`operation_id: gate-R`) → approval window opens, `~12s left`.
2. Tunnel killed. The relay abandoned the exchange at **26.0 s** with
   `{"detail":"Device did not respond in time"}`. The prompt stayed up, unanswered.
3. Tunnel restored; the app reconnected and re-authenticated.
4. **Retry with the same `operation_id`, before answering** → returned the existing
   pending handle immediately, and `/json/list` showed **one** approval window.
   `intent_received` did not increase. **One prompt.**
5. Allow Once clicked → file contains `once`; audit shows `file_write` **× 1**.
6. File overwritten with `TAMPERED`, then the same `operation_id` retried again →
   returned the stored result; **the file still read `TAMPERED`**. **One side effect.**

Fail-closed checks, all live:

| Case | Answer |
|---|---|
| Same id, different arguments | `{"status":"conflict"}`, `isError: true`, with the guidance text |
| A second agent looking up the first agent's handle | `{"status":"unknown"}` |
| The same second agent, an invented handle | `{"status":"unknown"}` — byte-identical shape |
| The same second agent, the first agent's `operation_id` | `{"status":"unknown"}` |

---

## Mutation checks run during this gate

Break the guard, watch a named test fail, restore, confirm green.

| # | Guard broken | Where | Observed |
|---|---|---|---|
| M1 | the relay acks unconditionally instead of only on a matched `resolve` | `plow/relay/ws.py` | 2 failed — `test_a_matched_response_is_acknowledged`, `test_an_old_mac_that_ignores_both_additions_still_completes_its_exchange` |
| M2 | exchange deadline back to 20 s | `plow/relay/pending.py` | 3 failed, including `test_the_deadline_leaves_the_mac_its_budget_and_its_delivery_margin` |
| D1 | `MIN_DELIVERY_MARGIN_MS` → 0 | `packages/relay-client/src/wire.ts` | 3 failed |
| D2 | `OPERATION_TTL_MS` → 1 | `packages/mcp-server/src/operations.ts` | 5 failed |
| D3 | `HANDLE_TTL_MS` → 1 | `packages/mcp-server/src/deferred.ts` | 7 failed |
| D4 | `OPERATION_TOMBSTONE_MS` → 0 | `packages/mcp-server/src/operations.ts` | **0 failed** — see finding 3 |

All sources restored; both suites green afterwards (113 relay, 592 desktop).

---

## Findings

### 1. BLOCKER — `just continuation-verify` is red at HEAD

The Chunk 3 gate script was not updated when Chunk 4 made `operation_id` a
required argument. At `5562be2`, on a clean M4 checkout:

```
"name": "a relay frame opened the real approval window",
"ok": false,
"detail": "… Input validation error: Invalid arguments for tool read_fi…"
```

The run stops at check 2 of 18 and exits 1. The two `read_file` frames in
`apps/desktop/scripts/continuation-verify.mjs` (lines 269 and 341) send no
`operation_id`.

This also means **`docs/verification/2026-08-19-chunk3-continuation.md` documents
a result that cannot be reproduced at HEAD** — it records 18/18 at `c9b59a4`, two
commits before the tool contract changed.

With `operation_id` added to those two frames — patched on the M4 copy only,
never committed, never in a git worktree — the run is **18/18, 0 failed**
(`continuation-verify-rerun.json`). So the *product* wiring is fine; the gate
script is stale. No product fix was made, per this run's brief.

### 2. Concern — two retry-safety tests are load-flaky

The first full `npx vitest run` on this Mac, executed while a Docker stack was
building, failed 2 of 593:

- `starts retention when the WORK lands, not when the envelope went out`
  (`operations.test.ts:481`) — got the pending handle where it expected `slow result`
- `survives the reconnect with one prompt and one side effect`
  (`operations.test.ts:740`) — read `''` where it expected `once`

Both passed on three consecutive isolated re-runs and in the full suite on an idle
machine, on this Mac and on the M4. They poll with `setTimeout(25)` wait loops
rather than waiting on a settle signal, so a loaded machine can exhaust the loop
before the work lands. Not a product defect; it is a suite that will go red in CI
on a busy runner, and these are exactly the two tests deliverable two rests on.

### 3. Concern — the tombstone duration is unguarded

`OPERATION_TOMBSTONE_MS` can be set to `0` and the entire `mcp-server` suite still
passes (mutation D4). §6 says a retired id "is then a tombstone before becoming
unknown"; the tests inject their own `ttlMs`/`tombstoneMs` through the
`Operations` constructor, so the shipped constant is never asserted. `OPERATION_TTL_MS`
and `HANDLE_TTL_MS` do not have this gap (D2, D3 both fail loudly).

The live run *did* observe a real tombstone (a retry of an expired id answered
`expired` and did not re-run), so the behavior is right today — nothing would
catch it changing.

### 4. Minor — `continuation-screenshots` hangs instead of failing

If `OUT_DIR` names a directory that does not exist, `shot()` throws an unhandled
rejection and the Electron process hangs forever rather than exiting. It looks
exactly like the silent-abort failure mode the Chunk 3 preflight work was written
to eliminate. `just continuation-screenshots` alone is safe — the recipe `mkdir -p`s
its default — but any explicit `OUT_DIR` is a trap.

---

## Limitations of this run

- **Onboarding was not exercised.** The device credential was minted by the API and
  written into `settings.json` directly. The activation wizard and the LINQ twin
  path were not driven; §8 does not ask for them.
- **The relay was never a real deployment.** Both stacks are `fastapi dev` in Docker
  on this Mac, reached over ssh tunnels. Latency, TLS termination and load balancing
  in front of a hosted relay are untested here.
- **One agent, one device, one Mac.** No concurrency: no two agents racing the same
  operation id, no two calls in flight against one approval window.
- **The adversarial reviewer never ran.** The local stack has no inference balance,
  so every intent recorded `adversarial_review_result: insufficient Plow balance`
  and fell through to `ask`. The approval path under a real reviewer verdict is
  not covered by this run.
- **Screenshots are viewport-only** (CDP `Page.captureScreenshot`), so content below
  the fold is absent; the report quotes window text as well for that reason.
- **Deliverable two's persistence bound is by design.** Dedup is process-local; an
  app restart frees every operation id. Not tested, because it is not a defect.
- **`git archive` was used for the old desktop**, so `abe1db3` was built from a
  detached export rather than a worktree. Build output was identical in kind; no
  git state anywhere was modified.
