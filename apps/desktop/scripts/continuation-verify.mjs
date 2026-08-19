// Drive the PRODUCTION approval-window path against real Electron.
//
// Everything here is the shipped code: `runApprovalWindow` (the same function
// `main.ts` calls), a real `BrowserWindow` with the real sandboxed preload, the
// real renderer, real `ipcMain`, and a real `Continuations` registry driven the
// way the relay drives it — `acknowledgeExchange`, `exchangeDeliveryUnknown`,
// and the deferred store's own `ready`/`collected` calls.
//
// The screenshot script next door is a VISUAL fixture and injects renderer
// state directly; it cannot prove any of this. This asserts the behaviour: the
// real window resizes, a real click delivers the decision, the copy IPC fires,
// and a terminal state actually destroys the window.
//
//   just continuation-verify
import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Continuations, exchangeContext } from "@domo/mcp-server";
import { runApprovalWindow } from "../dist/approvalWindow.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");

const INTENT = "9F2C1A44-0B77-4E3D-9A21-6C5E0D8B4417";
const HANDLE = "H-VERIFY";
const RID = "RID-VERIFY";

const REQUEST = {
  kind: "intent",
  view: {
    intentId: INTENT,
    agentDisplay: "Claude Code",
    agentId: "sess_01HZX9K4M2QP",
    goal: "Tidy up the quarterly report folder",
    request: "run: sips -Z 1600 ~/Documents/report/photos",
    planContext: null,
    capabilities: [
      { kind: "process.exec", display: "Run: sips -Z 1600 photos" },
      { kind: "fs.read", display: "Read: /Users/you/Documents/report/photos" },
    ],
    needsNetwork: false,
    writesFiles: false,
    runsCommand: true,
    usesBrowser: false,
    fillsCredentials: false,
    origins: [],
    credentialItems: [],
  },
};

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail ?? null });

/** The real registry, plus the adapter main.ts uses to read and subscribe. */
function registry(deadlineAt) {
  const audited = [];
  const cont = new Continuations({ record: (event) => audited.push(event) });
  cont.open(HANDLE, "sess_01HZX9K4M2QP", deadlineAt);
  cont.linkIntent(HANDLE, INTENT);
  exchangeContext.run({ rid: RID }, () => cont.deferred(HANDLE));
  const source = {
    snapshot: (intentId) => ({
      state: cont.stateOfIntent(intentId),
      deadlineAt: cont.deadlineOfIntent(intentId),
      deliveryUnknown: cont.deliveryUnknownOfIntent(intentId),
    }),
    subscribe: (listener) => {
      cont.events.on("change", listener);
      return () => cont.events.removeListener("change", listener);
    },
  };
  return { cont, source, audited };
}

let copyCalls = 0;
ipcMain.handle("approval:copyPhrase", async () => {
  copyCalls += 1;
  return true;
});

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

function makeWindow(created) {
  const win = new BrowserWindow({
    width: 460,
    height: 560,
    show: false,
    webPreferences: {
      preload: path.join(dist, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  created.push(win);
  return win;
}

/** Click a rendered button by label, with real mouse events. */
async function click(win, label) {
  const rect = await win.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll("button")].find((n) => n.textContent.trim() === ${JSON.stringify(label)});
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!rect) return false;
  for (const type of ["mouseDown", "mouseUp"]) {
    win.webContents.sendInputEvent({ type, x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  }
  await settle();
  return true;
}

const bodyText = (win) => win.webContents.executeJavaScript("document.body.innerText");

/** One run of the production opener, returning what it did. */
function openWindow(source, created) {
  const win = { current: null };
  const decision = runApprovalWindow(REQUEST, {
    ipc: ipcMain,
    createWindow: () => {
      win.current = makeWindow(created);
      return win.current;
    },
    loadFile: (w) => w.loadFile(path.join(dist, "renderer/approval.html")),
    continuation: source,
    lingerMs: 60_000,
  });
  return { win, decision };
}

// Electron swallows a rejection out of `whenReady().then()`: the process exits
// 0 having printed nothing, which reads exactly like a pass. Say what happened.
// Written to a file as well as stdout: `app.exit()` can kill the process
// before a piped stdout has flushed, and a verification whose output vanished
// reads exactly like one that passed.
const REPORT = process.env.VERIFY_OUT ?? "/tmp/continuation-verify.json";
const report = (body, code) => {
  const text = JSON.stringify(body, null, 2);
  fs.writeFileSync(REPORT, text);
  console.log("VERIFY:" + text);
  app.exit(code);
};
const die = (where) => (error) => {
  report({ error: `${where}: ${error?.stack ?? error}` }, 2);
};
process.on("uncaughtException", die("uncaught"));
process.on("unhandledRejection", die("rejection"));
// Each scenario ends by destroying its window, and an app with no windows left
// is an app Electron will quit out from under the next one — silently, exit 0,
// which reads exactly like a pass. This run says when it is finished.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  try {
    await verify();
  } catch (error) {
    report({ error: `verify threw: ${error?.stack ?? error}` }, 2);
  }
}, die("whenReady"));

async function verify() {
  const created = [];

  // ---- 1. Backgrounded, approved, collected -------------------------------
  {
    const { cont, source } = registry(Date.now() + 9_400);
    const { win, decision } = openWindow(source, created);
    await settle(700);

    // The relay acknowledges the handoff — the production callback, not a
    // renderer poke.
    cont.acknowledgeExchange(RID);
    await settle();
    const bg = await bodyText(win.current);
    check("backgrounded reaches the real window", bg.includes("stopped waiting"), bg.slice(0, 80));
    check("backgrounded gives the continue phrase", bg.includes("Continue the pending Plow request."));

    // A real click on the real button.
    const beforeSize = win.current.getContentSize();
    const clicked = await click(win.current, "Allow Once");
    check("Allow Once was clickable", clicked);
    const got = await decision;
    check("decision delivered to the caller", got === "allow_once", got);
    await settle();

    const afterSize = win.current.getContentSize();
    check(
      "window resized to the compact confirmation",
      afterSize[1] === 190 && beforeSize[1] > afterSize[1],
      `${beforeSize.join("x")} -> ${afterSize.join("x")}`,
    );
    check("window still open after a backgrounded decision", !win.current.isDestroyed());

    // The deferred store's own transitions.
    cont.ready(HANDLE);
    await settle();
    const ready = await bodyText(win.current);
    check("ready shows the copy action", ready.includes("Copy phrase"));
    const copied = await click(win.current, "Copy phrase");
    check("copy IPC fired from the real click", copied && copyCalls === 1, `copyCalls=${copyCalls}`);

    // The agent comes back for it: terminal, so the window must be destroyed.
    cont.collected(HANDLE);
    await settle();
    check("collection destroys the window", win.current.isDestroyed());
  }

  // ---- 2. Delivery unknown, then a decision --------------------------------
  {
    const { cont, source } = registry(Date.now() + 9_400);
    const { win, decision } = openWindow(source, created);
    await settle(700);

    // The socket died before the relay could acknowledge.
    cont.exchangeDeliveryUnknown(RID);
    await settle();
    const text = await bodyText(win.current);
    check("delivery unknown reaches the real window", text.includes("could not confirm"), text.slice(0, 80));
    check("delivery unknown claims neither waiting nor handed off",
      !text.includes("still waiting") && !text.includes("stopped waiting"));

    await click(win.current, "Allow Once");
    check("decision delivered after unknown delivery", (await decision) === "allow_once");
    await settle();
    check("window stays open on unconfirmed delivery", !win.current.isDestroyed());
    cont.ready(HANDLE);
    cont.collected(HANDLE);
    await settle();
    check("collection destroys it here too", win.current.isDestroyed());
  }

  // ---- 3. A failure after backgrounding -----------------------------------
  {
    const { cont, source } = registry(Date.now() + 9_400);
    const { win, decision } = openWindow(source, created);
    await settle(700);
    cont.acknowledgeExchange(RID);
    await settle();
    await click(win.current, "Allow Once");
    await decision;
    await settle();
    check("confirmation open before the failure", !win.current.isDestroyed());
    cont.failed(HANDLE);
    await settle();
    check("a failure destroys the confirmation", win.current.isDestroyed());
  }

  // ---- 4. Inline: answered while the call is demonstrably open -------------
  {
    const { source } = registry(Date.now() + 30_000);
    const { win, decision } = openWindow(source, created);
    await settle(700);
    const text = await bodyText(win.current);
    check("inline shows a measured countdown", /~\d+s left/.test(text), text.slice(0, 80));
    await click(win.current, "Deny");
    check("denial delivered", (await decision) === "deny");
    await settle();
    check("an inline decision closes the window at once", win.current.isDestroyed());
  }

  for (const w of created) if (!w.isDestroyed()) w.close();
  const failed = checks.filter((c) => !c.ok);
  report({ checks, failed: failed.length }, failed.length === 0 ? 0 : 1);
}
