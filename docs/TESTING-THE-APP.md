# Testing the app for real

How this app is verified now that the in-repo stand-in Plow is gone: `npx vitest run` locally, and
anything that needs a running app driven by hand against a **locally running plow API**.

The *why* behind real-input verification is in
`/Users/plucas/.claude-kitchen/projects/plow/wiki/ui-verification.md`. Read it once. The capture
procedure is in `/Users/plucas/.claude-kitchen/projects/domo-desktop/wiki/m4-screenshots.md` — the
head chef wants that kept as prose, not as a maintained script.

---

## What changed, and why this file is short now

There used to be a stand-in Plow in this repo — a fake HTTP API plus a `FakeRelay` WebSocket server
— and drivers that ran the real Electron app against it end to end. They are deleted. The head
chef's call: a locally running plow API already simulates plow, the PR should stay small and
targeted, and procedures belong in prose rather than in scripts somebody has to maintain.

Two of the deleted scripts (`e2e/relay-gate/gate.ts`, `apps/desktop/scripts/approve-drive.mjs`)
pointed at a **live** plow stack rather than at the stand-in. They went too, deliberately and by the
same ruling — so **be clear about what that leaves: there is no automated live-stack path any more,
in this repo or in CI.** The whole-flow walk against a real plow is a manual run, start to finish,
by a person following the sections below.

What went, and what it did:

| Deleted | What it did |
|---|---|
| `packages/relay-client/test/fakeRelay.ts` | The stand-in relay: plow's channel handshake, tunnelled HTTP exchanges. |
| `packages/relay-client/test/relayClient.test.ts` | The relay client's integration tests, which stood one up. |
| `e2e/relay-gate/gate.ts` | The relay + MCP end-to-end gate against a live plow variant stack. |
| `e2e/transcripts.test.ts` | Ran the transcript scripts under vitest. (The rest of `e2e/` stays: the worktree-naming test and the browser fixtures the package tests import.) |
| `apps/desktop/scripts/first-run-drive.mjs` | Drove the whole first run with real key and mouse events. |
| `apps/desktop/scripts/first-run-transcript.mjs` | The state machine end to end, plus a no-credential-in-a-log grep. |
| `apps/desktop/scripts/slow-approval-transcript.mjs` | The slow-approval / long-command round trip with timings. |
| `apps/desktop/scripts/approve-drive.mjs` | The app half of an acceptance run: seeded credential, real clicks. |

**What this costs, so nobody rediscovers it the hard way:** `@domo/relay-client` keeps only pure
wire-contract tests (`test/wire.test.ts` — `stripHopByHop`, `Host` preservation, frame validation).
Nothing in `npx vitest run` opens a socket, sends the auth frame, reconnects, or tunnels an MCP
call, and nothing in CI does either. Those paths are verified **by hand**, by running the app
against a locally running plow API and watching what happens.

---

## Why you cannot just check the DOM

This app shipped three times with a panel that rendered perfectly and accepted no click and no
keystroke. Every check passed, because every check reached into the page — set `.value`, called
`.click()` — which is the layer *below* the one that was broken.

The actual bug: an IPC getter that notified. `onboarding:get` called a `refresh()` that published a
change; the renderer re-reads on every change; so reading caused a change caused a read. About
5,000 re-renders a second, and `render()` rebuilds the tree with `replaceChildren`, so every input
and button was destroyed and recreated between frames. Focus could not survive it, and a click needs
mousedown and mouseup on the *same* element.

Nothing that manipulates the DOM directly can see that. Only real input can. So when you drive the
app by hand, drive it by hand — keyboard and mouse, not the inspector.

---

## What still runs headless

| Command | What it proves |
|---|---|
| `npx vitest run` | Every pure state machine: `Onboarding`, `ConnectClient`, `WindowGate`, the policy engine, the MCP server, protocol golden vectors. Function-level fakes only; nothing spins up a server. |
| `just onboarding-screenshots` | Every Set Up screen renders its required content; fails if any is missing. |
| `just connect-screenshot` | The Connect-a-client screen: the OAuth route, the static-credential form, the copy-once block. |
| `just approval-screenshot` | The approval dialog names the calling agent. |
| `just verify-preload` | The sandboxed preload bridge and both renderers still work. |
| `just viewer-screenshot` | The audit screen's live-browser thumbnail. |

Every `just` recipe above except `npx vitest run` launches Electron. **Run them on the M4, never on the head chef's Mac** —
windows flash on screen otherwise. The wiki page has the rsync/build/capture procedure, including the
two traps that waste an hour: exclude `*.tsbuildinfo` (or `tsc -b` emits nothing and you get blank
PNGs), and repair Electron's binary when `node_modules/electron/path.txt` is missing.

---

## Driving the app by hand

**Point a build at a local API.** Baked in, deliberately — there is no Settings field, because a
credential is only valid against the environment that minted it. **Every build defaults to
production** (`https://api.plow.co`), including a run from source, so targeting a local relay is a
deliberate act:

```bash
just app                                          # production, ~/Library/Application Support/Plow-Latch-<branch>
DOMO_API_BASE_URL=http://localhost:4242 just app  # that relay, …/Plow-Latch-<branch>-local
DOMO_HOME=/tmp/plow-latch-x just app                    # an explicit home always wins
```

There is no local default and no flag — you export the URL you want.

`<branch>` is this checkout's normalized branch name (`scripts/worktree-name.sh --branch`), so every
checkout — main included — has its own home, and none of them is the packaged install's unsuffixed
`~/Library/Application Support/Plow-Latch`.

**Setting the override moves the home too**, to `…/Plow-Latch-<branch>-local`, unless you set `DOMO_HOME`
yourself. A credential is only valid against the environment that minted it, so a local one landing
in the production-facing home would overwrite the credential there and cost you a re-onboarding.
Plain `just app` against production still uses `…/Plow-Latch-<branch>`.

Outside `just`, nothing moves the home for you. Set both, or you are running a local relay against
production-facing state:

```bash
DOMO_HOME=/tmp/plow-latch-local DOMO_API_BASE_URL=http://localhost:4242 npx electron apps/desktop
```

**Reset to first-run state.** State lives under `DOMO_HOME` (default
`~/Library/Application Support/Plow-Latch-<branch>` under `just`). With no `relayCredential` in
`app/settings.json` the app is behind the login gate: the Set Up window is the only window there
is, and there is no main window until the wizard's last button hands over:

```bash
DOMO_HOME=$(mktemp -d) just app                                    # a clean first run, your real state untouched
rm ~/Library/Application\ Support/Plow-Latch-<branch>/app/settings.json  # or reset the real one
```

`just` recipes default `DOMO_HOME` to this checkout's `Plow-Latch-<branch>` home — your *real* dev one.
Always pass a throwaway to anything that writes state.

**A new session is not a new browser.** Sessions come and go, but the cookies do not: a session
browses in a persistent Camoufox profile under `$DOMO_HOME/device/browser/profiles/`, one per
approved origin set. That is deliberate — it is what keeps a site's logins and its recognition of
this device across sessions — and it is a trap when you are chasing a site that has *rejected* us.
A bot block is written into that profile as a cookie (Kasada's `KP_UIDz`, Akamai's `_abck`), so
"open a fresh session and try once" replays the block and looks like proof the block is permanent.
See #86, where exactly that reading was on the table.

Run with no persistent profile at all when you are reproducing a block, or anything else where the
browser must arrive with no history:

```bash
DOMO_BROWSER_FRESH_PROFILE=1 just app   # every session starts with an empty cookie jar
```

Inspect what a profile is holding — `sqlite3` reads it fine while the browser is closed:

```bash
HOME_DIR=~/Library/Application\ Support/Plow-Latch-$(scripts/worktree-name.sh --branch)
sqlite3 "$HOME_DIR/device/browser/profiles/<key>/cookies.sqlite" \
  "select host, name, datetime(creationTime/1000000,'unixepoch') from moz_cookies order by host;"
```

`$DOMO_HOME` is set by the `just` recipes, not in your shell, so spell the home out — the packaged
install's is the unsuffixed `~/Library/Application Support/Plow-Latch`.

`browser_started` in the audit log names the directory that browser opened — read it there rather
than hashing the origins yourself, since a grant whose first profile was given up opens `<key>-2`
next time. Deleting a profile directory is safe with the app shut
down; it costs that grant its logins and nothing else. A store older than this change has a single
`device/browser/profile` beside `profiles/` with everything mixed together; nothing reads it any
more, so delete it whenever.

**Widening a live session signs it out for next time.** `plow_browser_request` with new origins
leaves the jar holding cookies for an origin the grant it was filed under does not name — so that
profile is given up on the spot (a `domo-abandoned` file inside it, `browser_profile_abandoned` in
the log). The session goes on using it; nothing opens it again, and the next session on those
origins gets an empty one at `<key>-2`. That is what an unexplained sign-out looks like now, and
deleting an abandoned directory once its session has closed is always safe.

Two things this deliberately does not do, both learned the hard way: it does not move the directory
— renaming it under a running Camoufox was tried, and every cookie written afterwards was lost
(`cookies.sqlite` came back with no `-wal` and none of the session's cookies) — and it does not
wait for session close, because a quit tears the process down mid-shutdown and `kill -9` never gets
there at all. The integration tier guards both.

**See the logs.** Main-process `console.log` (including `[relay]` and `[onboarding]`) goes to the
terminal you launched from. Renderer console does not — subscribe to it:

```js
win.webContents.on("console-message", (_e, level, message) => console.log(`RENDERER[${level}] ${message}`));
```

To attach DevTools to a running app: `npx electron --remote-debugging-port=9222 apps/desktop`, then
open `http://localhost:9222`. A normally-launched app has no debugging port — you cannot attach
after the fact, so start it that way if you might need it.

**Build before you run.** Every script loads from `dist/`, not `src/`:

```bash
npx tsc -b && node apps/desktop/scripts/copy-renderer.mjs   # or: just build
```

**No top-level `await` in a script that boots the app.** Electron does not emit `ready` until the
entry module finishes evaluating, and the app hangs its whole startup off `app.whenReady()`. A
top-level await means the app under test never boots and you get "the window never appeared".

---

## Approvals are answered by a human, on purpose

A tool call through the real app **prompts**. There is no auto-allow for read-only:
`PolicyEngine.decide` (`packages/device-core/src/policyEngine.ts:64`) has no capability-kind fast
path — it goes straight to the delegate, which in this app is the dialog. **Do not add a bypass
flag**, and do not use `HeadlessPolicy` for a run that is supposed to prove the app works; both are
false greens by construction.

The product's own escape hatch is the answer. The dialog is its own `BrowserWindow`, title
`Domo — Approve`, buttons `["Deny", "Always Allow", "Allow Once"]`. Click **Always Allow** once and
later identical calls need nobody — the rule persists to `${DOMO_HOME}/device/rules.json` under

```
SHA-256 over { agent: agentId, device: deviceId, caps: normalized(capabilities).sorted() }
```

(`packages/protocol/src/capability.ts:58`). Goal text is excluded — wording is free. Everything else
is not, so an unattended run needs **the same agent credential, the same device, and the same exact
capability shape** every time. Three traps, all confirmed the hard way:

- **`agentId` is the agent credential's session id.** A chain that mints a fresh agent credential
  per run gets a different key every run: Always Allow then persists *within* a run and never across
  them. Expect exactly **one prompt per run**.
- **`argv` survives into the key verbatim.** A nonce in the command line changes the shape every
  time. Keep argv constant and put the varying part somewhere else — a file's contents, read back.
- **Paths are canonicalized to *physical* paths** (realpath — `/private/var/...`, not `/var/...`), so
  a call built from a per-run temp directory produces a different key each time.

And wiping `DOMO_HOME` between runs wipes the rule with it.

---

## Run against a stack nobody else is editing

This is a manual procedure — there is no script left that does it, and by ruling there will not be
one. Bring up the stack yourself, run `just app` against it, and drive the app.

The dev API runs `fastapi dev`, which reloads on every file change in the worktree it is mounted
from. A colleague saving `ws.py` mid-run drops the device socket and stalls requests for tens of
seconds; what you see is a call that should have failed in 50 ms taking 25 s, or a tunnelled call
timing out client-side — symptoms indistinguishable from a product bug, and they cost an evening
once. So give the run its own stack, pinned to a commit:

```bash
git -C <plow-worktree> worktree add -b my-stack /Users/…/plow/my-stack <sha>
echo PLOW_VARIANT=my-stack > /Users/…/plow/my-stack/.env.local
cd /Users/…/plow/my-stack/api && ../app/scripts/plow-dev-env --output ../.plow-dev-env --variant my-stack
cd .. && docker compose --env-file .plow-dev-env -f compose.yaml up -d api dtu-linq dtu-google-oauth dtu-gmail db
```

The variant picks its own ports (`grep PORT ../.plow-dev-env`) and its own compose project, so it
does not collide with anyone else's. If the API 503s or a call times out mid-run, check
`docker logs <project>-api-1 | grep -i reload` before suspecting the app.

---

## What a UI ticket owes

1. **A description of what was actually driven** — what was typed and clicked, and what the app did
   in response. Not a DOM read, and not a claim from a passing unit test.
2. **A screenshot per screen changed**, captured on the M4.
3. **Red-then-green**, when the change fixes a defect: for anything covered by vitest, the test
   failing on the broken code and passing on the fix, both outputs verbatim.
