# Chunk 3 — approval-window continuation: real-window verification

What was run, on what, and what it proved. Kept in the repo because the run
itself cannot be: it needs Electron, Electron runs on the M4, and a reviewer
reading this branch has neither. A screenshot proves a window looked right; the
table below is the part that says the wiring behind it works.

- **Commit verified:** `c9b59a4` (re-run unchanged on the follow-up commit that
  added the preflight; same 18/18).
- **Where:** `plucas-m4`, macOS 27.0, Electron 33.4.11, node v26.7.0, in
  `~/plow-pbc/codex-chunk3` (per-branch directory — see the M4 procedure).
- **How:** `just continuation-verify`
  (`apps/desktop/scripts/continuation-verify.mjs`).
- **Raw report:** `2026-08-19-chunk3-continuation-verify.json`, beside this file
  — the run writes it itself, so this is its output rather than a transcription.

## What the run actually drives

A `relay.request` frame goes into a real `RelayClient` — wired by
`relayOptions`, the same function `main.ts` builds its client from — over a real
`createDomoMcpServer` and a real `DeviceAgent`, with the real sandboxed preload
and renderer in a real `BrowserWindow`. Clicks are real mouse events through
`sendInputEvent`; evaluation reads bounding rects and text back, and never
clicks anything.

The only stand-in is the **socket**: frames are handed to the client the way the
relay would hand them over, because the relay is another repository's program
and is not running here. Everything downstream of that socket is production
code, which is the point — an acknowledgement travels
`relay.response.ack` → `RelayClient` → `onResponseAck` →
`server.acknowledgeExchange` → `Continuations` → the window.

## Result: 18 checks, 0 failed

| # | Check | What it would catch |
|---|---|---|
| 1 | the handshake configured the server's budgets | an advertised deadline that never reaches the server (15000/15000 from 25s) |
| 2 | a relay frame opened the real approval window | the tunnelled call never reaching policy |
| 3 | the window counts down the call it arrived on | a countdown that is not the call's measured remainder |
| 4 | the deferred answer went back on that exchange | the budget expiring without answering the relay |
| 5 | and it is a pending handle, not a result | a call that blocked past its budget |
| 6 | **an ack FRAME moved the window to backgrounded** | the relay-callback wiring — the finding this run exists for |
| 7 | and it names the phrase that brings the agent back | §4's continuation guidance missing |
| 8 | Allow Once was clickable | a button the renderer draws but cannot receive input on |
| 9 | the real window resized to the confirmation | 460x532 → 460x190; a confirmation left card-sized |
| 10 | the ready result offers the copy action | the copy action missing when it would help |
| 11 | copy IPC fired from a real click | a button wired to nothing |
| 12 | the agent's lookup was served over the relay | `get_result` not reachable as a second exchange |
| 13 | and it carried the result | the payload not surviving the round trip |
| 14 | collection destroying the window | a blank confirmation left on screen |
| 15 | second window opened | the scenario's own setup |
| 16 | a dropped socket told the window delivery is unconfirmed | delivery-unknown never reaching the UI |
| 17 | and it claims neither waiting nor handed off | the window guessing in either direction |
| 18 | a denial closes the window even here | a confirmation that cannot be dismissed by deciding |

## Mutation matrix

Every guard was broken, the break was observed to fail, and the source was
restored. W5 and W6 are the ones that matter for this chunk: they were run
against the **real window on the M4**, not against a unit harness.

| # | Break | Where | Observed |
|---|---|---|---|
| W1 | `onResponseAck` wired to `exchangeDeliveryUnknown` | `relayWiring.test.ts` | 1 failed |
| W2 | `onDeliveryUnknown` forwards nothing | `relayWiring.test.ts` | 1 failed |
| W3 | rid dropped from `serve` | `relayWiring.test.ts` | 1 failed |
| W4 | advertised budgets never applied | `relayWiring.test.ts` | 1 failed |
| W5 | `onResponseAck` made a no-op | **M4 real window** | exit 1 — "an ack FRAME moved the window to backgrounded" failed |
| W6 | `window-all-closed` hold removed | **M4 real window** | the silent abort reproduced: exit 0, **no report file written** |

W6 is the prelaunch/abort failure mode itself, reproduced deliberately: an
Electron app with no windows left quits, exit 0, printing nothing — which reads
exactly like a pass. The run now holds itself open and writes its report to a
file, because `app.exit` can outrun a piped stdout.

## When Electron cannot run at all

`just continuation-verify` and `just continuation-screenshots` preflight with
`apps/desktop/scripts/electron-preflight.mjs` before Electron is asked to start,
and refuse with the repair steps rather than launching something that will die
without explaining itself. It checks the three failures that look identical from
the outside: Electron not installed, `path.txt` missing or newline-terminated
(npm ≥ 11 blocks the postinstall, and Electron 33 does not trim the file), and
an unbuilt `dist/`. Inside the run — where Electron has clearly started — the
same check reports a missing build as `exit 3` with the guidance in the report,
rather than eighteen failures with an unrelated cause. (The run loads its built
modules with `await import` after that check, rather than at the top: a static
import of a file an unbuilt tree does not have dies during module evaluation,
before anything can say why.)

Each refusal was produced deliberately on the M4 and then undone:

| Broken | Result |
|---|---|
| `path.txt` removed | preflight exit 1, repair steps printed |
| `path.txt` given a trailing newline | preflight exit 1, the `printf` fix printed |
| `dist/relayWiring.js` removed | preflight exit 1; inside Electron, **exit 3** with the guidance in the report |

## Repeating it

Per the M4 procedure (`~/.claude-kitchen/projects/domo-desktop/wiki/m4-screenshots.md`):
rsync to a **per-branch** directory excluding `node_modules`, `dist` and
`*.tsbuildinfo`, repair Electron's binary if `path.txt` is missing, `just build`,
then `just continuation-verify`. The exit code is the gate; the JSON report says
which check failed.
