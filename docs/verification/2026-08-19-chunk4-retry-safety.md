# Chunk 4 — retry safety: what was proved, and how

Retry deduplication is the kind of feature whose tests all pass whether or not
it works: a suite that calls each tool once never notices that a second
identical call would run again. What makes these tests worth anything is the
mutation column — each guard was broken deliberately, the break was observed to
fail a named test, and the source was restored.

Kept in the repo because a reviewer cannot re-derive it: the list below is the
record of which guards are actually load-bearing.

- **Implemented:** `e88ad61` (§6), review fixes in the commit carrying this file.
- **Suite:** `npx vitest run` — 592 passed, 1 skipped, 45 files.
- **Focused tests:** `packages/mcp-server/test/operations.test.ts` (18) and the
  three classification tests in `packages/mcp-server/test/classification.test.ts`.

## The contract, and where each half is tested

| §6 says | Test |
|---|---|
| a caller-supplied id, 1–128 URL-safe characters | "accepts 1-128 URL-safe characters and nothing else" |
| records scoped to `(agent_id, operation_id)` | "gives each agent its own operation under the same id" |
| a canonical fingerprint of tool + arguments, minus the id | "fingerprints the request without the name given to it" |
| the same id and fingerprint gets the existing state or result | "asks the human once and writes the file once"; "hands a repeat of a still-pending operation the same handle" |
| a different fingerprint is a conflict | "is a conflict, and leaves the original answerable" |
| another agent's use of the id is an independent record | "gives each agent its own operation under the same id" |
| a cross-agent lookup is indistinguishable from unknown | "answers a cross-agent lookup exactly as it answers an invented id" |
| `get_result` takes exactly one of handle or id | "refuses a lookup that names both a handle and an id" |
| pending stays live; terminal is retrievable for 15 min | "answers, then expires, then frees the id"; "starts retention when the WORK lands" |
| the id is then a tombstone before becoming unknown | same two |
| process-lifetime at-most-once, not exactly-once | in-memory records; stated in `operations.ts` |

The end-to-end case §6 is written for — a socket lost mid-operation and a retry
on a new one — is `"survives the reconnect with one prompt and one side effect"`,
driven through the real `RelayClient`: request frame in, pending handle out,
socket dies, reconnect, retry on the new socket. One prompt, one write, and a
third retry leaves a deliberately-rewritten file untouched.

## Mutation matrix

Break, observe the failure, restore. The suite was green after every restore.

| # | Guard broken | Tests failed |
|---|---|---|
| O1 | dedupe bypassed entirely — every call runs | 7 |
| O2 | the record is registered only once the work finishes | 1 |
| O3 | the fingerprint includes the operation id | 1 |
| O4 | a mismatched fingerprint replays instead of conflicting | 1 |
| O5 | one shared namespace instead of one per agent | 3 |
| O6 | the tombstone lookup removed — a retired id re-runs | 2 |
| O7 | `get_result` by id reads another agent's namespace | 1 |
| O8 | the id format is not enforced | 2 |
| O9 | a deferred operation never starts retention | 1 |
| O10 | the deferred store never tells anyone its work landed | 1 |
| O11 | the tombstone answers before the fingerprint is compared | 1 |
| O12 | a denial is remembered as a plain failure | 1 |
| O13 | `get_result` does not validate the id it is given | 1 |

O2 is worth a note: the first attempt at it moved registration after `work()`
but still synchronously, which the test cannot tell apart from correct ordering.
Redone as "register only once the envelope settles" — the failure that can
actually happen — and it failed as it should. A mutation that does not fail has
proved nothing about the guard; it has only proved something about the mutation.

## What the review found afterwards, and what changed

Five findings, all of them cases where the feature looked right and was not:

1. **A deferred operation never settled.** Retention started only for a call
   that answered inline, so an operation that deferred — the common case, and
   the one this feature exists for — reserved its id for the life of the
   process. The deferred store now says when a handle's work lands
   (`DeferredResults.settled`), and that is when the operation's clock starts.
   (O9, O10.)
2. **A tombstone outranked the fingerprint.** Reusing an id for different work
   after its result expired answered "expired" instead of "conflict", letting a
   caller's bug look like a retry that arrived late. The fingerprint is compared
   first now, tombstone or not. (O11.)
3. **A denial became a failure.** A lookup by id flattened "the owner said no"
   into "it broke" — the one place in the system those two were not kept apart.
   (O12.)
4. **`get_result` did not validate the id.** A malformed id was answered
   `unknown`, which hid the caller's mistake behind a legitimate answer. (O13.)
5. **The evidence was not in the repo.** This file.
