// Launch the real app already signed in, wait for its socket, and click
// approvals — nothing else.
//
// This is the app half of the acceptance run. Someone else (the relay-gate
// cook) owns the chain: they mint the account, the `relay:device` credential
// and the agent credential, and they fire the tool call. This script exists so
// the device end of that chain is the REAL Electron app instead of a headless
// device process, and so the approval dialog gets answered by a real click
// rather than by a bypass that would make the run meaningless.
//
// It is deliberately separate from `first-run-drive.mjs`: that one proves the
// first-run flow from a clean home and owns its own stand-in Plow. This one
// brings no server, asserts nothing about onboarding, and is pointed at
// whatever stack the caller already has running.
//
//   PLOW_API_BASE=http://127.0.0.1:19264 \
//   PLOW_DEVICE_TOKEN=plow_… \
//   just approve-drive
//
// Everything is env-configured; nothing is hardcoded to a stack.
//
//   PLOW_API_BASE      required. The API origin. The app derives its socket
//                      from this by swapping the scheme and appending
//                      /v1/relay/ws — there is no separate relay-URL setting,
//                      so HTTP and the socket MUST share this origin.
//   PLOW_DEVICE_TOKEN  optional. A `relay:device` credential to seed. Omit it
//                      when DOMO_HOME already holds one — whoever minted it may
//                      have seeded it themselves, and this script will then
//                      touch no settings at all.
//   DOMO_HOME          optional. Defaults to a fresh temp dir. State lives here
//                      — including the always-allow rule, so reuse the SAME
//                      home across runs if you want them unattended.
//   PLOW_ACCOUNT_UID   optional, display only.
//   PLOW_MCP_URL       optional, display only.
//   PLOW_DECISION      optional, "always_allow" (default) or "allow_once".
//                      Always Allow persists a rule so later identical calls
//                      need nobody; Allow Once does not.
//   PLOW_RUN_MINUTES   optional, default 30. How long to keep answering.
//   PLOW_EXIT_AFTER    optional. Exit 0 after this many approvals. Set it to 1
//                      for a run that expects exactly one prompt, so the script
//                      finishes instead of idling out its clock.
//   PLOW_FORCE_SEED    optional. Required to overwrite a DIFFERENT credential
//                      that is already in DOMO_HOME. See the guard below.
//
// THIS SCRIPT OWNS THE APP INSTANCE. It launches the app in its own process; it
// cannot attach to one that is already running. If an instance is already up
// against the target DOMO_HOME, stop that one first — two devices on one
// credential is not a thing the relay expects.
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

const API_BASE = process.env.PLOW_API_BASE;
const DEVICE_TOKEN = process.env.PLOW_DEVICE_TOKEN;
const EXIT_AFTER = process.env.PLOW_EXIT_AFTER ? Number(process.env.PLOW_EXIT_AFTER) : null;
const DECISION = process.env.PLOW_DECISION ?? "always_allow";
const RUN_MS = Number(process.env.PLOW_RUN_MINUTES ?? 30) * 60_000;
const BUTTON = DECISION === "allow_once" ? /Allow Once/i : /Always Allow/i;

const say = (what) => console.log(`----      ${what}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!API_BASE) {
  console.log("FATAL: PLOW_API_BASE is required.");
  process.exit(2);
}

async function main() {
  // 1. Seed the credential exactly where the app reads it. `relayCredential`
  //    being present is what makes the app skip onboarding entirely and dial at
  //    boot — no UI login, nothing typed.
  const home = process.env.DOMO_HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), "approve-"));
  fs.mkdirSync(path.join(home, "app"), { recursive: true, mode: 0o700 });
  const file = path.join(home, "app/settings.json");
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const already = (existing.relayCredential ?? "").trim();

  if (!DEVICE_TOKEN && !already) {
    console.log(`FATAL: no credential. Pass PLOW_DEVICE_TOKEN, or point DOMO_HOME at a home that already holds one.`);
    return app.exit(2);
  }

  if (!DEVICE_TOKEN) {
    // Whoever minted it seeded it. Touch nothing — this home may belong to a
    // real user, and rewriting their settings file to say the same thing is a
    // needless chance to say something different.
    say(`using the credential already in ${file} (prefix ${already.slice(0, 9)}…)`);
  } else if (already && already !== DEVICE_TOKEN && !process.env.PLOW_FORCE_SEED) {
    // A different credential is already here. This is somebody's live install —
    // overwriting it costs them a re-onboarding they did not ask for.
    console.log(`FATAL: ${file} already holds a DIFFERENT credential (prefix ${already.slice(0, 9)}…).`);
    console.log(`       Use a dedicated DOMO_HOME for test runs, or set PLOW_FORCE_SEED=1 if you really mean to replace it.`);
    return app.exit(2);
  } else {
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          ...existing,
          relayCredential: DEVICE_TOKEN,
          accountUid: process.env.PLOW_ACCOUNT_UID ?? existing.accountUid ?? "",
          mcpUrl: process.env.PLOW_MCP_URL ?? existing.mcpUrl ?? "",
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    fs.chmodSync(file, 0o600);
    say(`device credential seeded into app/settings.json (0600), prefix ${DEVICE_TOKEN.slice(0, 9)}…`);
  }

  process.env.DOMO_HOME = home;
  process.env.DOMO_API_BASE_URL = API_BASE;
  say(`DOMO_HOME ${home}`);
  say(`API base ${API_BASE} — the app will dial ${API_BASE.replace(/^http/, "ws")}/v1/relay/ws`);

  // 2. The app's own main process.
  await import(path.join(dir, "../dist/main.js"));

  // 3. Wait for ITS OWN connection indicator, not for a guess of ours. The main
  //    window's status line reads from the live RelayClient.
  const mainWindow = await waitForWindow("Domo Desktop");
  if (!mainWindow) {
    console.log("FATAL: the main window never appeared.");
    return app.exit(1);
  }
  let connected = false;
  for (let i = 0; i < 600 && !connected; i += 1) {
    const text = await mainWindow.webContents
      .executeJavaScript(`document.getElementById("statusText")?.textContent ?? ""`)
      .catch(() => "");
    connected = text.startsWith("Connected");
    if (!connected) await sleep(200);
  }
  // The authority on the socket is the relay's own `GET /v1/relay/info`
  // (`device_connected`), which the chain owner checks independently. This is
  // only the app's side of that handshake.
  console.log(`READY: device_socket_connected=${connected}`);
  if (!connected) {
    console.log("FATAL: the app never reported a connected socket. Check PLOW_API_BASE and the token.");
    return app.exit(1);
  }
  say("the app is up and connected — waiting for approval dialogs");
  say(`answering with ${DECISION === "allow_once" ? "Allow Once" : "Always Allow"} for up to ${RUN_MS / 60_000} minutes`);
  if (EXIT_AFTER) say(`exiting after ${EXIT_AFTER} approval(s)`);
  // EXPECT ONE PROMPT PER RUN, not one ever. The rule key includes the agentId,
  // which is the agent credential's session id — a chain that mints a fresh
  // agent credential per run (which is the point of a live-credential gate)
  // gets a fresh key every run, so Always Allow persists WITHIN a run and never
  // across them. Never wait for a second call to be silent.

  // 4. Answer every dialog that opens, with real events, until time runs out.
  let answered = 0;
  const deadline = Date.now() + RUN_MS;
  while (Date.now() < deadline) {
    const dialog = BrowserWindow.getAllWindows().find(
      (w) => w.getTitle().includes("Approve") && !w.webContents.isLoading(),
    );
    if (!dialog) {
      await sleep(250);
      continue;
    }
    // macOS gives key focus only to the frontmost app; an unfocused window
    // swallows sendInputEvent exactly as it would swallow a real mouse.
    app.focus({ steal: true });
    dialog.show();
    dialog.focus();
    dialog.webContents.focus();
    await sleep(400);

    const target = await dialog.webContents.executeJavaScript(`
      (() => {
        const el = [...document.querySelectorAll("button")]
          .find((b) => ${BUTTON}.test(b.textContent));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
        const top = document.elementFromPoint(x, y);
        return { x, y, label: el.textContent.trim(),
                 reachable: top === el || el.contains(top),
                 onTop: top ? top.tagName + "." + top.className : null };
      })()
    `);
    if (!target) {
      console.log("APPROVAL: dialog open but the button was not found — leaving it alone");
      await sleep(1000);
      continue;
    }
    if (!target.reachable) {
      // Do NOT route around this with .click(). An unreachable button is the
      // finding, not an obstacle.
      console.log(`APPROVAL FAIL: "${target.label}" is not reachable at its own coordinates — ${target.onTop} is on top`);
      return app.exit(1);
    }
    const what = await dialog.webContents
      .executeJavaScript(`document.body.innerText.replace(/\\s+/g, " ").slice(0, 160)`)
      .catch(() => "");
    dialog.webContents.sendInputEvent({ type: "mouseDown", x: target.x, y: target.y, button: "left", clickCount: 1 });
    await sleep(40);
    dialog.webContents.sendInputEvent({ type: "mouseUp", x: target.x, y: target.y, button: "left", clickCount: 1 });
    answered += 1;
    console.log(`APPROVAL: clicked "${target.label}" (#${answered}) — ${what}`);
    await sleep(800);
    if (EXIT_AFTER && answered >= EXIT_AFTER) break;
  }

  const rulesFile = path.join(home, "device/rules.json");
  const rules = fs.existsSync(rulesFile) ? JSON.parse(fs.readFileSync(rulesFile, "utf8")) : [];
  console.log(`DONE: answered=${answered} rules_persisted=${rules.length}`);
  for (const rule of rules) console.log(`RULE: ${rule.ruleKey}`);
  // A run that answered nothing is not a pass: the whole point is the click.
  app.exit(answered > 0 ? 0 : 1);
}

async function waitForWindow(fragment, ms = 30_000) {
  for (let i = 0; i < ms / 100; i += 1) {
    const found = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes(fragment));
    if (found && !found.webContents.isLoading()) return found;
    await sleep(100);
  }
  return null;
}

// No top-level await: Electron withholds `ready` until this module finishes
// evaluating, and the app under test hangs its startup off `app.whenReady()`.
main().catch((error) => {
  console.log(`FATAL: the harness threw — ${error?.stack ?? error}`);
  app.exit(1);
});
