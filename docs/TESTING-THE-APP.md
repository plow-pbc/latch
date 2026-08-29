# Testing the app for real

How this app is verified now that the in-repo stand-in Plow is gone: `npx vitest run` locally, and
anything that needs a running app driven by hand against a **locally running plow API**.

The *why* behind real-input verification, and the screenshot-capture procedure,
live in the maintainers' private wiki (`ui-verification.md` and
`m4-screenshots.md`) — the head chef wants those kept as prose, not as
maintained scripts.

For the *installed* app rather than the code — what an unattended run can and
cannot do to a real install, and the one real MCP call that proves one works —
see [AUTONOMOUS-OPERATION.md](AUTONOMOUS-OPERATION.md) and the `latch-smoke`
skill beside it.

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

One leg of it is not, and it is the leg with no unit coverage at all: `scripts/latch-smoke` drives a
real MCP call through the relay to an installed app and reads the verdict out of `audit.ndjson`. That
proves the relay, the device socket, the MCP server and the exec path — it does not walk the UI, and
it needs an install and a client registration, so it does not make the walk above optional.

What went, and what it did:

| Deleted | What it did |
|---|---|
| `packages/relay-client/test/fakeRelay.ts` | The stand-in relay: plow's channel handshake, tunnelled HTTP exchanges. |
| `packages/relay-client/test/relayClient.test.ts` | The relay client's integration tests, which stood one up. (Its lifecycle checks survive against a fake connection in `lifecycle.test.ts` / `liveness.test.ts`.) |
| `e2e/relay-gate/gate.ts` | The relay + MCP end-to-end gate against a live plow variant stack. |
| `e2e/transcripts.test.ts` | Ran the transcript scripts under vitest. (The rest of `e2e/` stays: the worktree-naming test and the browser fixtures the package tests import.) |
| `apps/desktop/scripts/first-run-drive.mjs` | Drove the whole first run with real key and mouse events. |
| `apps/desktop/scripts/first-run-transcript.mjs` | The state machine end to end, plus a no-credential-in-a-log grep. |
| `apps/desktop/scripts/slow-approval-transcript.mjs` | The slow-approval / long-command round trip with timings. |
| `apps/desktop/scripts/approve-drive.mjs` | The app half of an acceptance run: seeded credential, real clicks. |

**What this costs, so nobody rediscovers it the hard way:** nothing in `npx vitest run` or in CI
opens a socket to a *real* relay or tunnels an MCP call end to end. That path is verified **by
hand**, by running the app against a locally running plow API and watching what happens.

What `@domo/relay-client` still covers in process — the wire contract, and the socket lifecycle
against a fake connection — is enumerated in [README-ts.md](../README-ts.md#integration-coverage)
§ Integration coverage, which owns that list. Read it before calling a relay-leg gap untestable.

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

## Browser behaviors the fill path rests on

`_type_value` in `vendor/browser-server/server.py` decides what it can send as
keystrokes from assumptions about what a real browser does with a key and with
an assigned value. **The suite cannot check any of them** — `fillProbe.py`
drives fake nodes that answer a `typeable=` knob and read back exactly what was
typed, so a scenario is green whether the assumption holds or not.

Three of them, in the order the code reaches them:

1. `type()` sends a newline as **Enter**, which a `<textarea>` takes as one line
   break. Every other typed node has breaks normalized away before anything is
   sent.
2. `type()` sends a tab as **Tab**, which moves focus instead of adding a
   character. A value holding one in its typed tail is assigned whole instead.
   More generally, what `type()` does with a character depends on whether it is
   on Playwright's key map — one that is not may arrive as inserted text with no
   key events at all, which is the outcome the whole typing path exists to
   avoid. So a value going through `el.type` is the code asking for key events,
   not a guarantee it got them; `KEY_DELAY_MS` is spent inside that call either
   way.
3. An `<input>` **sanitizes an assigned value**, and differently per type. CR
   and LF never survive. Some types will not keep a leading or trailing tab.

The one that bites: **an assignment is not a guarantee the node kept the
value** — the tab guard's branch returns without asking `KEYS_DROPPED_JS` at
all, and on the split path a value that lost its *leading* character is not a
prefix of what was wanted, so the check answers false. This is `fill()`'s own
behavior, older than the typing work, and it is still the first thing to suspect
if a credential lands short.

What the fill now tells you about it:

- A completed fill carries **`altered`** when the field is holding something
  other than what went into it — whatever the field did to it, and whether or
  not the field said it would. It is a fact and not a verdict: a card box
  rendering the digits it was given with spaces in them has changed nothing that
  counts, and only a caller who knows what the value means can say. A fill
  without it landed exactly.
- A **credential** fill is the case where that is decided for you: the value
  came out of the vault, so `fillSecret` refuses a field that changed it and
  says a changed copy is still sitting there. Clearing it is left to whoever can
  see the page.
- A value the field says it cannot hold is refused **before the node is
  touched**, answering `too_long` with the field's own cap, so the page is left
  exactly as it was found. Measured against what this node will actually
  receive — a `<textarea>` keeps its breaks and an `<input>` does not, so the
  same value can fit one and not the other.

Do not trust the specifics above — the per-type details have been written down
wrong here more than once. **Confirm against the field**: drive the real fill
through the MCP server against a page you control, then read the value back the
same way the page would and compare it to what you asked for. Re-check whichever
assumption you touched whenever you change the fill path.

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
DOMO_HOME=$(mktemp -d) just app                                    # a clean first run; real state untouched, except ~/Plow (created deliberately — the playground is the owner's)
rm ~/Library/Application\ Support/Plow-Latch-<branch>/app/settings.json  # or reset the real one
```

`just` recipes default `DOMO_HOME` to this checkout's `Plow-Latch-<branch>` home — your *real* dev one.
Always pass a throwaway to anything that writes state.

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

## Approvals follow the approval mode — select Ask before the dialog procedure

Which decider a tool call reaches depends on the app's approval mode. The **default is
adversarial**: the AI reviewer allows or denies with **no dialog** — a fresh install never prompts,
and its verdict lands in the audit log, not on screen. The dialog procedure below needs **Ask
mode**: select it in the app first, or you will wait on a dialog that never opens. There is no
auto-allow for read-only in any mode: `PolicyEngine.decide`
(`packages/device-core/src/policyEngine.ts:64`) has no capability-kind fast path — it goes straight
to the delegate. **Do not add a bypass flag**, and do not use `HeadlessPolicy` for a run that is
supposed to prove the app works; both are false greens by construction.

Under Ask mode, the product's own escape hatch is the answer. The dialog is its own `BrowserWindow`, title
`Plow Latch — Approve`, buttons `["Deny", "Always Allow", "Allow Once"]`. Click **Always Allow** once and
later identical calls need nobody — the rule persists to `${DOMO_HOME}/device/rules.json` under

```
SHA-256 over { agent: agentId, device: deviceId, caps: normalized(capabilities).sorted() }
```

(`packages/protocol/src/capability.ts:58`). Goal text is excluded — wording is free. Everything else
is not, so an unattended run needs **the same agent credential, the same device, and the same exact
capability shape** every time. One carve-out: an `apple_events` intent — a Contacts or Messages
write — shows only `["Deny", "Allow Once"]` and is decided fresh every time; the engine neither
stores nor replays a rule for it (`policyEngine.ts`'s `ruleEligible`), so there is no unattended
replay to test on that path. Three traps, all confirmed the hard way:

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

## Release gate: apple_events under the hardened runtime

The `apple_events` capability compiles to a Seatbelt `(allow appleevent-send)` rule
(`packages/device-core/src/executor.ts`), but that rule only lets an *unhardened* process send
Apple events. A notarized build additionally needs the automation entitlement
(`com.apple.security.automation.apple-events` in `apps/desktop/build/entitlements.mac.plist`) and
an `NSAppleEventsUsageDescription` in the packaged Info.plist (`apps/desktop/electron-builder.yml`
`mac.extendInfo`) — without both, macOS silently denies the send even though the dev-app smoke
(which runs unhardened) passes.

This is a **manual release gate, not a CI check** — it requires a real notarized, signed build, and
CI does not produce one. After cutting a notarized build:

1. Grant the running app permission when macOS prompts for Apple Events / Automation access (or
   pre-approve it in System Settings → Privacy & Security → Automation).
2. Drive one real `apple_events:true` send through `scripts/latch-smoke` — the same script the
   dev-app installed-app smoke uses, per `#184` — with its `--apple-events` flag, which is what
   puts `apple_events: true` in the tool arguments so the send exercises the granted path rather
   than the Seatbelt denial:

   ```sh
   scripts/latch-smoke --config <install-config> --home "~/Library/Application Support/Plow-Latch" \
     --apple-events -- /usr/bin/osascript -e 'tell application "Messages" to send "release-gate" to participant "+1<your-number>" of (first account whose service type = iMessage)'
   ```
3. Confirm the corresponding `exec_end` line in `audit.ndjson` shows `exit 0`. A `-1743`
   (`errAEEventNotPermitted`) or similar AppleScript error there means the entitlement or usage
   string regressed in that build — check both before re-signing.

Do this once per release candidate, not per PR — a Seatbelt-only smoke on the dev app cannot catch
an entitlement/Info.plist regression, and this is the only place that can.

---

## What a UI ticket owes

1. **A description of what was actually driven** — what was typed and clicked, and what the app did
   in response. Not a DOM read, and not a claim from a passing unit test.
2. **A screenshot per screen changed**, captured on the M4.
3. **Red-then-green**, when the change fixes a defect: for anything covered by vitest, the test
   failing on the broken code and passing on the fix, both outputs verbatim.
