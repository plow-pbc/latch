// Walk the REAL approval window through the continuation states, with the REAL
// preload, and capture each one — driving every transition the way the product
// does: recorded state changes over IPC, and real mouse events into the
// renderer for the clicks.
//
// `Runtime`-style evaluation is used ONLY to read bounding rects and text back.
// Nothing here calls .click() or assigns values: synthesized input goes in at
// the event layer so hit-testing, focus and the re-render all get exercised —
// which is the class of bug that has shipped in this window before.
//
//   just continuation-screenshots           → /tmp/continuation-*.png
//   OUT_DIR=/path just continuation-screenshots
import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");
const outDir = process.env.OUT_DIR ?? "/tmp";
// A directory that is not there makes every capture throw, and an unhandled
// rejection inside `whenReady` leaves Electron alive with nothing to do — the
// run hangs instead of failing, which is the worst of the two.
if (!fs.existsSync(outDir)) {
  console.error(
    `OUT_DIR does not exist: ${outDir}\n` +
      `  fix: mkdir -p "${outDir}"   (or unset OUT_DIR to write to /tmp)`,
  );
  process.exit(1);
}

const INTENT_ID = "9F2C1A44-0B77-4E3D-9A21-6C5E0D8B4417";

// The view model approvalViewModel() builds from a verified intent, plus the
// continuation the registry is tracking for it: state, and the ABSOLUTE
// deadline of the call that asked. 9.4s left of a 15s budget — a call that has
// already spent part of it, which is the honest case.
let continuation = { state: "waiting_inline", deadlineAt: Date.now() + 9_400 };

ipcMain.handle("approval:get", async () => ({
  kind: "intent",
  suggesting: false,
  continuation,
  view: {
    intentId: INTENT_ID,
    agentDisplay: "Claude Code",
    agentId: "sess_01HZX9K4M2QP",
    goal: "Tidy up the quarterly report folder",
    request: "run: sips -Z 1600 ~/Documents/report/photos",
    planContext: null,
    capabilities: [
      { kind: "process.exec", display: "Run: sips -Z 1600 photos" },
      { kind: "fs.read", display: "Read: /Users/you/Documents/report/photos" },
      { kind: "fs.write", display: "Write: /Users/you/Documents/report/out" },
      { kind: "network", display: "Network: denied" },
    ],
    needsNetwork: false,
    writesFiles: true,
    runsCommand: true,
    usesBrowser: false,
    fillsCredentials: false,
    origins: [],
    credentialItems: [],
  },
}));
ipcMain.handle("approval:ready", async () => true);

let copied = 0;
ipcMain.handle("approval:copyPhrase", async () => {
  copied += 1;
  return true;
});
const decisions = [];
ipcMain.on("approval:decide", (_e, id, decision) => decisions.push({ id, decision }));
const dismissals = [];
ipcMain.on("approval:dismiss", (_e, id) => dismissals.push(id));

const results = [];

// Say what went wrong rather than hanging: an unhandled rejection out of the
// run below would otherwise leave Electron up with no window and no output.
const die = (where) => (error) => {
  console.error(`SHOT_ERROR:${where}: ${error?.stack ?? error}`);
  app.exit(2);
};
process.on("uncaughtException", die("uncaught"));
process.on("unhandledRejection", die("rejection"));

app.whenReady().then(async () => {
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
  const settle = () => new Promise((r) => setTimeout(r, 350));
  const text = () => win.webContents.executeJavaScript("document.body.innerText");
  const shot = async (name) => {
    const out = path.join(outDir, `continuation-${name}.png`);
    fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
    return out;
  };
  /** Click a button by its rendered label, with real mouse events. */
  const click = async (label) => {
    const rect = await win.webContents.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll("button")].find((n) => n.textContent.trim() === ${JSON.stringify(label)});
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!rect) throw new Error(`no button labelled ${label}`);
    for (const type of ["mouseDown", "mouseUp"]) {
      win.webContents.sendInputEvent({ type, x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    }
    await settle();
  };

  await win.loadFile(path.join(dist, "renderer/approval.html"));
  await settle();

  // 1. waiting_inline — the call is still open, and the strip shows the
  //    MEASURED remainder rather than a fresh budget.
  const inlineText = await text();
  results.push({
    state: "waiting-inline",
    png: await shot("waiting-inline"),
    saysWaiting: inlineText.includes("still waiting"),
    // 9.4s of budget left, rendered as ~10s. A "15" here would mean the window
    // re-promised the whole budget after preflight.
    countdown: /~\d+s left/.exec(inlineText)?.[0] ?? null,
    promisesFreshBudget: inlineText.includes("15s"),
    offersCopy: inlineText.includes("Copy phrase"),
  });

  // 2. backgrounded — a RECORDED change, exactly as main forwards it when the
  //    relay acknowledges the handoff. Nothing here is a timer.
  continuation = { state: "backgrounded", deadlineAt: continuation.deadlineAt };
  win.webContents.send("approval:continuation", { intentId: INTENT_ID, state: "backgrounded" });
  await settle();
  const bgText = await text();
  results.push({
    state: "backgrounded",
    png: await shot("backgrounded"),
    saysStoppedWaiting: bgText.includes("stopped waiting"),
    givesPhrase: bgText.includes("Continue the pending Plow request."),
    // Still a question: the buttons are there and no copy action yet.
    stillAsking: bgText.includes("Allow Once"),
    offersCopy: bgText.includes("Copy phrase"),
  });

  // 3. The human approves — a real mouse click on the real button — and the
  //    window becomes a confirmation instead of closing.
  await click("Allow Once");
  // Mirrors what main does on a decision it keeps the window open for: the
  // question is answered, so the window shrinks to the size of what is left to
  // say (see openApprovalWindow's `finish`).
  win.setContentSize(460, 190);
  win.webContents.send("approval:decided", { intentId: INTENT_ID });
  await settle();
  const confirmText = await text();

  // 4. approved_uncollected — the result is ready and the agent has not asked.
  win.webContents.send("approval:continuation", {
    intentId: INTENT_ID,
    state: "approved_uncollected",
  });
  await settle();
  const readyText = await text();
  results.push({
    state: "approved-uncollected",
    png: await shot("approved-uncollected"),
    decided: decisions.length === 1 && decisions[0].decision === "allow_once",
    collapsedToConfirmation: !confirmText.includes("Allow Once"),
    saysReady: readyText.includes("ready and waiting"),
    givesPhrase: readyText.includes("Continue the pending Plow request."),
    offersCopy: readyText.includes("Copy phrase"),
  });

  // The copy action, clicked for real.
  await click("Copy phrase");
  const afterCopy = await text();

  // 5. collected — the agent came back; the copy action goes and the window
  //    has nothing left to show.
  win.webContents.send("approval:continuation", { intentId: INTENT_ID, state: "collected" });
  await settle();
  const collectedText = await text();

  const report = {
    shots: results,
    copyPressed: copied === 1,
    copyConfirmed: afterCopy.includes("Copied"),
    collectedClearsCopy: !collectedText.includes("Copy phrase"),
  };
  console.log("CONTINUATION:" + JSON.stringify(report, null, 2));

  const ok =
    results.length === 3 &&
    results[0].saysWaiting &&
    results[0].countdown !== null &&
    !results[0].promisesFreshBudget &&
    !results[0].offersCopy &&
    results[1].saysStoppedWaiting &&
    results[1].givesPhrase &&
    results[1].stillAsking &&
    !results[1].offersCopy &&
    results[2].decided &&
    results[2].collapsedToConfirmation &&
    results[2].saysReady &&
    results[2].offersCopy &&
    report.copyPressed &&
    report.copyConfirmed &&
    report.collectedClearsCopy;
  app.exit(ok ? 0 : 1);
}, die("whenReady"));
