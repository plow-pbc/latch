# What was done about the release-gate findings

The gate run itself is `README.md` in this directory, left exactly as the QA
cook wrote it — including the parts that are no longer true, because a record of
what was found is worth more than a record edited to look clean. This file says
what changed afterwards.

All four findings are fixed in the commit that carries this file.

## 1. BLOCKER — `just continuation-verify` was red at HEAD

`apps/desktop/scripts/continuation-verify.mjs` sent two `read_file` frames with
no `operation_id`, which Chunk 4 had made a required argument. The gate stopped
at check 2 of 18.

Both frames now carry one (`verify-read-1`, `verify-read-2`). Re-run on the M4
at this commit: **18 checks, 0 failed, exit 0**.

The QA cook was right that this also stranded
`../2026-08-19-chunk3-continuation.md`, which recorded 18/18 at `c9b59a4` — a
result that could not be reproduced two commits later. That file now says which
commit it was re-run at.

A gate script is product code for this purpose: it is the only thing that
notices the wiring breaking, so it breaking is the same class of problem.

## 2. Concern — two retry-safety tests were load-flaky

`starts retention when the WORK lands` and `survives the reconnect with one
prompt and one side effect` sampled with `setTimeout(25)` loops until the work
landed. A fixed number of naps is a guess about how busy the machine is, and on
a loaded one the guess was wrong.

Both now WAIT rather than sample:

- settlement is awaited through the continuation registry's own change event
  (`whenSettled`), which is the recorded fact the test is actually about;
- the relay response is awaited through the scripted socket, which resolves a
  waiter when this Mac writes the frame for that rid.

No `setTimeout` polling remains in `operations.test.ts`. Three consecutive full
suite runs on this Mac: 593 passed, 1 skipped, 45 files.

## 3. Concern — the tombstone duration was unguarded

Mutation D4 (`OPERATION_TOMBSTONE_MS` → 0) failed nothing, because every test
injected its own windows through the constructor and the shipped constant was
never exercised.

There is now a test that builds `OperationRecords` with **default** windows and
only an injected clock, and walks the whole life of an id: answerable just
inside retention, a tombstone just after it, still reserved a moment before the
tombstone ends, and gone once it has. Re-running D4 against it:

| Mutation | Observed |
|---|---|
| `OPERATION_TOMBSTONE_MS` → 0 | **1 failed** — "ships fifteen minutes of retention and fifteen more of tombstone" |
| `OPERATION_TTL_MS` → 1 | **2 failed** |

## 4. Minor — `continuation-screenshots` hung instead of failing

An `OUT_DIR` naming a directory that does not exist made every capture throw,
and the unhandled rejection left Electron alive with nothing to do.

Two changes, because they answer different halves of it: the directory is
checked before Electron is asked to do anything, and the run now has
uncaught-exception and rejection handlers that print and exit rather than
leaving the process up.

| Case | Before | Now |
|---|---|---|
| `OUT_DIR` missing | hangs forever | **exit 1**, `OUT_DIR does not exist: … fix: mkdir -p …` |
| same, with the guard deliberately removed | hangs forever | **exit 2**, with the stack |
| `OUT_DIR` present | three PNGs | three PNGs, exit 0 |
