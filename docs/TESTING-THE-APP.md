# Testing the app for real

How to drive this Electron app the way a person does — real key events, real clicks — and assert on
what the app actually did.

The *why* is in `/Users/plucas/.claude-kitchen/projects/plow/wiki/ui-verification.md`. Read it once.
This file is the *how*, and it must run start to finish for someone who has never opened this repo.

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

Nothing that manipulates the DOM directly can see that. Only real input can.

**Banned as evidence:** setting `.value`, `element.click()`, `.focus()`, dispatching a synthetic
`Event`, calling a handler directly, or a screenshot on its own. They may appear while you debug.
None may appear in a Done-when.

---

## Run the harness

```bash
cd /Users/plucas/plow-pbc/domo-desktop
npm install
just first-run-drive
```

Exit code 0 and `every check passed` on the last line. Screenshots land in `/tmp/drive-*.png`
(`OUT_DIR=/somewhere just first-run-drive` to move them).

It drives the **whole first run**: activation code on screen → the text arrives → device credential
minted → socket connected → click the agent-name field → type a name → click Create Agent → the
config comes back. Then it sweeps the main window's tab bar the same way.

Drive the whole flow, not one screen. Every bug of the last two days lived in a seam between
screens: a `busy` flag never cleared, a request with no deadline, a getter that notified.

### Prove your check can fail

**A check that has never failed is indistinguishable from a check that asserts nothing.** Before you
trust a new one, run it against the commit that has the bug:

```bash
git stash                                    # park your fix
git checkout <broken-sha> -- apps/desktop/src   # or just the files the fix touches
npx tsc -b && node apps/desktop/scripts/copy-renderer.mjs
npx electron apps/desktop/scripts/first-run-drive.mjs   # expect CHECK FAIL
git checkout HEAD -- apps/desktop/src && git stash pop
npx tsc -b && node apps/desktop/scripts/copy-renderer.mjs
npx electron apps/desktop/scripts/first-run-drive.mjs   # expect every check passed
```

Both transcripts go in your report. This is not optional and it costs you five minutes.

---

## Writing your own

Copy `apps/desktop/scripts/first-run-drive.mjs`. The shape:

**1. Stand up a fake Plow on ONE origin.** The app derives its socket URL from its API base by
swapping the scheme, so HTTP and the WebSocket must share a port or the app dials somewhere you are
not:

```js
const api = http.createServer(/* … */);
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const API_BASE = `http://127.0.0.1:${api.address().port}`;
const { FakeRelay } = await import("../../../packages/relay-client/dist-test/fakeRelay.js");
const relay = await FakeRelay.start({ expectCredential: DEVICE_TOKEN, server: api });
```

**2. Point the real app at it and boot it.** Both env vars must be set *before* the import:

```js
process.env.DOMO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "drive-"));  // clean = first run
process.env.DOMO_API_BASE_URL = API_BASE;
await import("../dist/main.js");   // the app's OWN main process
```

Import the real `main.js`. Do **not** re-register your own `ipcMain` handlers — the bug above lived
in a handler, and every harness that stubbed them was green while the app was dead.

**3. Get a window handle** by title, once it has stopped loading:

```js
const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes("Set Up"));
```

**4. Make the app frontmost.** macOS gives key focus only to the frontmost app, and an unfocused
window swallows `sendInputEvent` exactly as it would swallow a real keyboard. Skip this and you get
a red run that is your fault:

```js
app.focus({ steal: true });
win.show(); win.focus(); win.webContents.focus();
```

**5. Hit-test, then click at real coordinates.** If the click does not land on the element you
meant, *that is the finding* — do not route around it with `.click()`:

```js
const { x, y, reachable } = await win.webContents.executeJavaScript(`
  (() => { const el = document.querySelector('input[placeholder="Claude Code"]');
           const r = el.getBoundingClientRect();
           const x = Math.round(r.x + r.width/2), y = Math.round(r.y + r.height/2);
           const top = document.elementFromPoint(x, y);
           return { x, y, reachable: top === el || el.contains(top) }; })()`);

win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
win.webContents.sendInputEvent({ type: "mouseUp",   x, y, button: "left", clickCount: 1 });
```

**6. Type with the full triple**, one per character. `char` alone does not always land:

```js
for (const ch of "Claude Code") {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: ch });
  win.webContents.sendInputEvent({ type: "char",    keyCode: ch });
  win.webContents.sendInputEvent({ type: "keyUp",   keyCode: ch });
}
```

**7. Assert on what the APP did** — the request that reached your fake server, the state it now
holds, the file it wrote. Never on the value you just typed:

```js
check("the request reached Plow", seen.agents === 1);
check("carrying the name that was typed", agentsBody.name === "Claude Code");
```

**8. Screenshot as the second artifact**, never the only one:

```js
fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
```

### Two checks worth copying into any UI harness

```js
// The DOM must hold still. A tree being rebuilt cannot be typed into.
await js(`window.__churn = 0;
  new MutationObserver(() => window.__churn++)
    .observe(document.getElementById("root"), { childList: true, subtree: true });`);
await sleep(1500);
check("the DOM is not rebuilding itself while idle", (await js("window.__churn")) === 0);
```

```js
// Nothing interactive inside -webkit-app-region: drag — those elements are
// inert in Electron. NOTE: the property is not inherited, so the NEAREST
// ancestor that declares one wins; a no-drag closer to the element re-enables
// it. The main window's tabs sit in a drag titlebar and work for exactly that
// reason, so a naive "any drag ancestor" walk reports a false positive.
```

---

## Answering an approval dialog

A tool call through the real app **prompts a human**. There is no auto-allow for read-only:
`PolicyEngine.decide` (`packages/device-core/src/policyEngine.ts:64`) has no capability-kind fast
path — it goes straight to the delegate, which in this app is the dialog. **Do not add a bypass
flag**, and do not use `HeadlessPolicy` for a run that is supposed to prove the app works; both are
false greens by construction.

The product's own escape hatch is the answer. The dialog is its own `BrowserWindow`, title
`Domo — Approve`, buttons `["Deny", "Always Allow", "Allow Once"]`. Click **Always Allow** once, with
real events, and later identical calls need nobody:

```js
const call = relay.agentCall(/* … */);          // do NOT await — it blocks on the human
const approval = await waitForWindow("Approve");
approval.show(); approval.focus(); approval.webContents.focus();
// hit-test "Always Allow", then mouseDown/mouseUp at those coordinates
const result = await call;
```

**What makes the rule carry forward.** `always_allow` persists to `${DOMO_HOME}/device/rules.json`
under a key that is

```
SHA-256 over { agent: agentId, device: deviceId, caps: normalized(capabilities).sorted() }
```

(`packages/protocol/src/capability.ts:58`). Goal text is excluded — wording is free. Everything else
is not, so an unattended run needs **the same agent credential, the same device, and the same exact
capability shape** every time. Three traps, all confirmed the hard way:

- **`agentId` is the agent credential's session id.** A chain that mints a fresh agent credential
  per run — which is the whole point of a live-credential gate — gets a different key every run.
  Always Allow then persists **within** a run and never across them. Expect exactly **one prompt per
  run**, and never write a harness that waits for the second call to be silent: it will wait forever.
- **`argv` survives into the key verbatim.** A nonce in the command line changes the shape every
  time. Keep argv constant and put the varying part somewhere else — a file's contents, read back.
- **Paths are canonicalized to *physical* paths** (realpath — `/private/var/...`, not `/var/...`), so
  a call built from a per-run temp directory produces a different key each time.

And wiping `DOMO_HOME` between runs wipes the rule with it.

`just first-run-drive` does all of this at the end of its run: a real `read_file` through the relay
into the app, the dialog answered by a real click, a per-run nonce proving the call executed on this
machine, then the same call again with no dialog.

### Driving the app as one half of a bigger run

When someone else owns the chain — they mint the account, the `relay:device` credential and the
agent credential, and they fire the tool call — the app side is `just approve-drive`. It brings no
server of its own: it seeds the credential, launches the real app, waits for the socket, and then
answers approval dialogs with real clicks until told to stop.

```bash
PLOW_API_BASE=http://127.0.0.1:19264 \
PLOW_DEVICE_TOKEN=plow_… \
DOMO_HOME=/tmp/acceptance-home \
just approve-drive
```

| Env | |
|---|---|
| `PLOW_API_BASE` | **required.** The API origin. The socket is derived from it — they must share an origin. |
| `PLOW_DEVICE_TOKEN` | Optional. A `relay:device` credential to seed. **Omit it** when whoever minted it has already written it into `DOMO_HOME` — the script then touches no settings at all. |
| `DOMO_HOME` | Defaults to a fresh temp dir. The always-allow rule lives here — **reuse the same home** across runs or every run prompts. |
| `PLOW_DECISION` | `always_allow` (default) or `allow_once`. |
| `PLOW_RUN_MINUTES` | How long to keep answering. Default 30. |
| `PLOW_EXIT_AFTER` | Exit 0 after this many approvals. **Set it to `1`** for a run that expects one prompt. |
| `PLOW_FORCE_SEED` | Required to overwrite a *different* credential already in `DOMO_HOME`. |

**It owns the app instance** — it launches the app itself and cannot attach to one already running.
Stop any existing instance against that `DOMO_HOME` first; two devices on one credential is not
something the relay expects. And **always use a dedicated `DOMO_HOME`**: the script refuses to
overwrite a different credential without `PLOW_FORCE_SEED`, because pointing it at somebody's live
install would cost them a re-onboarding.

It prints `READY: device_socket_connected=true` once the app's own status line says connected —
that is the app's half of the handshake. The authority is still the relay's
`GET /v1/relay/info` → `device_connected: true`, checked by whoever owns the chain. Each click logs
`APPROVAL: clicked "Always Allow" (#n)`, and the run exits non-zero if it answered nothing or if a
button was not reachable at its own coordinates. It never prints the credential.

**Where the app reads its two values** — the answer to the question every integration asks:

| | |
|---|---|
| Relay socket URL | **Not configurable.** Derived from `DOMO_API_BASE_URL`: same origin, `http`→`ws`, path `/v1/relay/ws`. |
| Device credential | `${DOMO_HOME}/app/settings.json`, key `relayCredential`, mode 0600. |

With `relayCredential` present at launch the app skips onboarding entirely and dials at boot — no UI
login, nothing typed.

**Run against a stack nobody else is editing.** The dev API runs `fastapi dev`, which reloads on
every file change in the worktree it is mounted from. A colleague saving `ws.py` mid-run drops the
device socket and stalls requests for tens of seconds, and what you see is a call that should have
failed in 50 ms taking 25 s, or a tunnelled call timing out client-side — symptoms indistinguishable
from a product bug, and they cost an evening once. So give the run its own stack, pinned to a commit:

```bash
git -C <plow-worktree> worktree add -b my-stack /Users/…/plow/my-stack <sha>
echo PLOW_VARIANT=my-stack > /Users/…/plow/my-stack/.env.local
cd /Users/…/plow/my-stack/api && ../app/scripts/plow-dev-env --output ../.plow-dev-env --variant my-stack
cd .. && docker compose --env-file .plow-dev-env -f compose.yaml up -d api dtu-linq dtu-google-oauth dtu-gmail db
```

The variant picks its own ports (`grep PORT ../.plow-dev-env`) and its own compose project, so it
does not collide with anyone else's. Copy a working `api/.env` and fix the ports in it — in
particular `OAUTH_REDIRECT_BASE_URL`, which is the origin `mcp_config` hands to the agent. If the
API 503s or a call times out mid-run, check `docker logs <project>-api-1 | grep -i reload` before
suspecting the app.

---

## Things you cannot guess

**Point a build at a local API.** Baked in, deliberately — there is no Settings field, because a
credential is only valid against the environment that minted it. The developer override:

```bash
DOMO_API_BASE_URL=http://localhost:18804 just app
```

An unpackaged run already defaults to `http://localhost:18804`; a packaged one to
`https://api.plow.co`.

**Reset to first-run state.** State lives under `DOMO_HOME` (default `~/.domo`). The app opens the
Set Up window when `app/settings.json` holds no `relayCredential`:

```bash
DOMO_HOME=$(mktemp -d) just app          # a clean first run, your real state untouched
rm ~/.domo/app/settings.json             # or reset the real one
```

`just` recipes default `DOMO_HOME` to `~/.domo` — your *real* one. Always pass a throwaway to
anything that writes state.

**See the logs.** Main-process `console.log` (including `[relay]` and `[onboarding]`) goes to the
terminal you launched from. Renderer console does not — subscribe to it:

```js
win.webContents.on("console-message", (_e, level, message) => console.log(`RENDERER[${level}] ${message}`));
```

To attach DevTools to a running app: `npx electron --remote-debugging-port=9222 apps/desktop`, then
open `http://localhost:9222`. A normally-launched app has no debugging port — you cannot attach
after the fact, so start it that way if you might need it.

**No top-level `await` in a harness entry file.** Electron does not emit `ready` until the entry
module finishes evaluating, and the app hangs its whole startup off `app.whenReady()`. A top-level
await means the app under test never boots and you get "the window never appeared". Wrap everything
in an async `main()` and call it.

**Electron cannot import `.ts`.** The `just` transcripts run under `vite-node` and can; anything run
under `npx electron` cannot. `FakeRelay` is compiled to
`packages/relay-client/dist-test/fakeRelay.js` by `npx tsc -b` for exactly this reason.

**Build before you run.** Every script loads from `dist/`, not `src/`:

```bash
npx tsc -b && node apps/desktop/scripts/copy-renderer.mjs   # or: just build
```

---

## What a UI ticket owes

1. **A real-input transcript** — what was typed and clicked, and what the app did in response.
2. **A reproducible screenshot** per screen changed, from a script that fails if the screen lost its
   content — not a hand-captured PNG.
3. **Red-then-green**, when the change fixes a defect: the same check failing on the broken build and
   passing on the fix, both outputs verbatim.

If your flow spans screens, drive the whole flow. A per-screen recipe would have caught none of the
bugs this document exists because of.

## The scripts

| Command | What it proves |
|---|---|
| `just first-run-drive` | The whole first run works under real keys and clicks. **Start here.** |
| `just approve-drive` | The app as one half of a bigger acceptance run: seeded credential, real socket, approvals answered by real clicks. |
| `just first-run-transcript` | The state machine and its failure paths, headless, including a no-credential-in-a-log grep. |
| `just onboarding-screenshots` | Every Set Up screen renders its required content; fails if any is missing. |
| `just approval-screenshot` | The approval dialog names the calling agent. |
| `just verify-preload` | The sandboxed preload bridge and renderer still work. |
| `npx vitest run` | Units and the headless end-to-end transcripts. |
