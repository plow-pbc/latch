// Render the REAL main window on the Audit tab, light and dark, on the real
// preload with stubbed IPC — and fail the run when the screen shifts while
// loading, a control has no accessible name, the keyboard cannot move the
// selection, a verdict landing alone does not sweep its row, or verdicts
// landing together sweep at all (a burst draws its marks and stays quiet).
//
//   just audit-screenshot       → audit-{light,dark}.png and audit-{light,dark}-decision.png
//   OUT_DIR=/path just audit-screenshot
import { app, ipcMain, nativeTheme } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shotWindow } from "./screenshot-harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");
const outDir = process.env.OUT_DIR ?? "/tmp";

const now = Date.now();
const ago = (s) => new Date(now - s * 1000).toISOString();
const row = (id, s, kind, title, decision, decisionTone, decisionKind, status, tone, statusKind, extra = {}) => ({
  id, ts: ago(s), blockedAt: null, kind, title,
  decision, decisionTone, decisionKind, status, tone, statusKind,
  agentDisplay: "Claude Code", agentId: "sess_01HZX9K4M2QP", goal: "Tidy the release notes and open a draft PR",
  command: null, intentId: `9F2C1A44-0B77-4E3D-9A21-6C5E0D8B44${id.slice(-2)}`, exitCode: null,
  capabilities: [], decidedBy: decision ? "You approved it" : null, ...extra,
});
const ROWS = [
  // Waiting on Gatekeeper when the window opens; its verdict streams in.
  row("act-00", 2, "file", "Read ~/Documents/Taxes/2025-return.pdf", "Pending", "zinc", "unanswered", "", "zinc", "none",
    { decidedBy: null, goal: "Summarise my tax return" }),
  row("act-01", 4, "command", "git status --short", "Allowed", "green", "allowed", "Running", "blue", "running",
    { command: "git status --short", capabilities: ["exec: git", "read: ~/workspace/notes"] }),
  row("act-02", 38, "browser", "Browse github.com", "Always allowed", "green", "allowed", "Completed", "green", "completed",
    { capabilities: ["browse: github.com, *.github.com"] }),
  row("act-03", 95, "file", "Read ~/workspace/notes/CHANGELOG.md", "Allowed", "green", "allowed", "Completed", "green", "completed"),
  row("act-04", 160, "command", "rm -rf ~/Library/Caches/*", "Denied", "red", "denied", "", "zinc", "none",
    { command: "rm -rf ~/Library/Caches/*", decidedBy: "Gatekeeper denied it" }),
  row("act-05", 420, "browser", "Fill sign-in on accounts.example.com", "Allowed", "green", "allowed", "Fill failed", "amber", "failed"),
  row("act-06", 900, "access", "Claude Code asked for access to this Mac", "Granted", "green", "allowed", "", "zinc", "none"),
  row("act-07", 1800, "command", "npm test", "Timed out", "amber", "unanswered", "", "zinc", "none", { command: "npm test" }),
  row("act-08", 3600, "file", "Write ~/workspace/notes/draft.md", "Allowed", "green", "allowed", "Error", "red", "failed", { exitCode: 1 }),
  row("act-09", 7200, "command", "brew outdated", "Allowed", "green", "allowed", "Completed", "green", "completed", { exitCode: 0 }),
];
const ORIGINAL = ROWS.map((r) => ({ ...r }));
const DETAIL = {
  "act-01": {
    timeline: [
      { text: "Requested: git status --short", at: ago(6), state: "" },
      { text: "Decision: allow — You", at: ago(5), state: "ok" },
      { text: "Started in sandbox", at: ago(4), state: "ok" },
    ],
  },
};

ipcMain.handle("status:get", async () => ({ deviceId: "probe", name: "Studio MacBook Pro", connected: true }));
ipcMain.handle("updates:get", async () => ({ supported: false }));
ipcMain.handle("gatekeeperRecovery:get", async () => null);
ipcMain.handle("ui:getTab", async () => "audit");
ipcMain.handle("ui:setTab", async () => {});
ipcMain.handle("vault:exchangePending", async () => null);
ipcMain.handle("settings:getInference", async () => ({ approvalMode: "adversarial" }));
ipcMain.handle("settings:getAgentPurpose", async () => "Only touch ~/workspace. Never send email.");
ipcMain.handle("rules:list", async () => [{}, {}, {}]);
ipcMain.handle("viewer:state", async () => ({ active: false }));
// Slow enough that a screen which draws nothing until the data lands would
// visibly jump when it does — the shift this run exists to catch.
const slow = (v) => new Promise((r) => setTimeout(() => r(v), 250));
ipcMain.handle("audit:page", async () => slow({ rows: ROWS, total: ROWS.length, size: ROWS.length }));
ipcMain.handle("audit:activity", async (_e, id) => {
  const r = ROWS.find((x) => x.id === id);
  return r ? { ...r, timeline: [], ...(DETAIL[id] ?? {}) } : null;
});

const send = (win, ids) => win.webContents.send("audit:changed", { ids });
const paint = (win) => win.webContents.executeJavaScript("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");

async function shoot(theme) {
  nativeTheme.themeSource = theme;
  const win = shotWindow(dist, { width: Number(process.env.W ?? 940), height: Number(process.env.H ?? 620), titleBarStyle: "hiddenInset" });
  // A hidden window is throttled like a background tab; the motion checks
  // below need its frames and timers at full rate.
  win.webContents.setBackgroundThrottling(false);
  // Layout shifts from the first paint on, buffered so none is missed.
  win.webContents.on("dom-ready", () => win.webContents.executeJavaScript(`
    window.__cls = 0;
    window.__shifts = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) {
      window.__cls += e.value;
      window.__shifts.push({ t: Math.round(e.startTime), v: e.value, src: (e.sources || []).map((s) => (s.node && s.node.nodeType === 1 ? s.node.className || s.node.tagName : String(s.node && s.node.nodeName)) + " " + JSON.stringify([s.previousRect.y, s.currentRect.y, s.previousRect.height, s.currentRect.height])) });
    } })
      .observe({ type: "layout-shift", buffered: true });
  `));
  await win.loadFile(path.join(dist, "renderer/index.html"));
  await new Promise((r) => setTimeout(r, 900));
  const cls = await win.webContents.executeJavaScript("window.__cls");
  if (process.env.SHIFTS) console.log("SHIFTS " + theme + " " + JSON.stringify(await win.webContents.executeJavaScript("window.__shifts"), null, 1));

  // Keyboard only, from the top: what each Tab lands on.
  win.webContents.focus();
  await win.webContents.executeJavaScript("document.activeElement.blur(); document.body.focus()");
  const tabStops = [];
  for (let i = 0; i < 14; i++) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await new Promise((r) => setTimeout(r, 40));
    tabStops.push(await win.webContents.executeJavaScript(`(() => {
      const a = document.activeElement;
      const name = (a.getAttribute("aria-label") || a.textContent || a.placeholder || "").trim().replace(/\\s+/g, " ").slice(0, 40);
      return (a.getAttribute("role") || a.tagName.toLowerCase()) + ": " + name;
    })()`));
  }

  const probe = await win.webContents.executeJavaScript(`(${() => {
    const named = (b) => (b.getAttribute("aria-label") || b.textContent || "").trim();
    const unnamed = [...document.querySelectorAll("button, input, textarea, [tabindex='0']")]
      .filter((b) => b.offsetParent !== null && !named(b) && !b.getAttribute("placeholder"))
      .map((b) => b.outerHTML.slice(0, 80));
    const sel = () => document.querySelector("tbody tr.sel")?.dataset.id ?? null;
    const before = sel();
    const list = document.querySelector(".activity");
    list.focus();
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    return new Promise((r) => setTimeout(() => r({
      rows: document.querySelectorAll("tbody tr").length,
      unnamed,
      before,
      after: sel(),
      listFocusable: list.tabIndex === 0,
      current: document.querySelector("[aria-current='page']")?.textContent.trim() ?? null,
      activeDescendant: list.getAttribute("aria-activedescendant") === document.querySelector("tbody tr.sel")?.id,
    }), 300));
  }})()`);
  await win.webContents.executeJavaScript("document.activeElement.blur()");
  await paint(win);
  const png = path.join(outDir, `audit-${theme}.png`);
  fs.writeFileSync(png, (await win.capturePage()).toPNG());

  // THE MOMENT: Gatekeeper's verdict on the waiting row lands live, and the
  // running activity in the detail pane gains a step.
  Object.assign(ROWS[0], { decision: "Denied", decisionTone: "red", decisionKind: "denied", decidedBy: "Gatekeeper denied it" });
  DETAIL["act-01"].timeline = [...DETAIL["act-01"].timeline, { text: "Output: 3 files changed", at: new Date().toISOString(), state: "ok" }];
  send(win, ["act-00", "act-01"]);
  await new Promise((r) => setTimeout(r, 330));
  const moment = await win.webContents.executeJavaScript(`({
    sweeping: !!document.querySelector("tbody tr.sweep.sweep-deny"),
    drawn: !!document.querySelector(".mark.just-decided.mark-red"),
    newStep: !!document.querySelector(".tl.tl-new"),
    liveStep: !!document.querySelector(".tl.tl-live"),
    elapsed: document.querySelector(".live-elapsed")?.textContent ?? null,
  })`);
  const momentPng = path.join(outDir, `audit-${theme}-decision.png`);
  fs.writeFileSync(momentPng, (await win.capturePage()).toPNG());

  // Bursts stay quiet: verdicts landing together get their marks drawn and no
  // sweep, and two a beat apart get one sweep between them — never two at once.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const byId = (id) => ROWS.find((r) => r.id === id);
  const pend = (ids) => {
    for (const id of ids) Object.assign(byId(id), { decision: "Pending", decisionTone: "zinc", decisionKind: "unanswered" });
    send(win, ids);
  };
  const decide = (id, deny = false) => Object.assign(byId(id), deny
    ? { decision: "Denied", decisionTone: "red", decisionKind: "denied" }
    : { decision: "Allowed", decisionTone: "green", decisionKind: "allowed" });
  const watchSweeps = (ms, ids) => win.webContents.executeJavaScript(`new Promise((resolve) => {
    const ids = ${JSON.stringify(ids)};
    const rows = new Set(); let most = 0; let marks = 0; let frames = 0; const end = performance.now() + ${ms};
    const tick = () => {
      frames++;
      const now = [...document.querySelectorAll("tbody tr.sweep")];
      most = Math.max(most, now.length);
      for (const tr of now) rows.add(tr.dataset.id);
      marks = Math.max(marks, ids.filter((id) =>
        document.querySelector('tbody tr[data-id="' + id + '"] .mark.just-decided')).length);
      if (performance.now() < end) requestAnimationFrame(tick); else resolve({ most, marks, frames, rows: [...rows] });
    };
    tick();
  })`);
  await wait(1700); // past the quiet window the moment above opened
  pend(["act-02", "act-03", "act-05"]);
  await wait(400);
  let watching = watchSweeps(800, ["act-02", "act-03", "act-05"]);
  await wait(30);
  decide("act-02"); decide("act-03", true); decide("act-05");
  send(win, ["act-02", "act-03", "act-05"]);
  const burst = await watching;
  // The burst's verdicts started main.js's quiet window (SWEEP_QUIET_MS, 5s);
  // the pair below must begin past it for its first verdict to sweep.
  await wait(5000);
  pend(["act-06", "act-07"]);
  await wait(400);
  watching = watchSweeps(1300, ["act-06", "act-07"]);
  await wait(30);
  // Far enough apart to land in separate refreshes (a page read here takes
  // 250ms), close enough to sit inside the quiet window.
  decide("act-06"); send(win, ["act-06"]);
  await wait(600);
  decide("act-07", true); send(win, ["act-07"]);
  const spaced = await watching;

  // Put the fixtures back for the next theme.
  ROWS.forEach((r, i) => Object.assign(r, ORIGINAL[i]));
  DETAIL["act-01"].timeline = DETAIL["act-01"].timeline.slice(0, 3);
  win.destroy();
  return { theme, png, momentPng, cls, tabStops, moment, burst, spaced, ...probe };
}

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const results = [await shoot("light"), await shoot("dark")];
  const ok = results.every((r) =>
    r.cls < 0.01 && r.rows === ROWS.length && r.unnamed.length === 0 &&
    r.before === "act-00" && r.after === "act-01" && r.listFocusable && r.current === "Audit" &&
    r.activeDescendant && r.moment.sweeping && r.moment.drawn && r.moment.newStep && r.moment.liveStep &&
    r.burst.most === 0 && r.burst.marks === 3 &&
    r.spaced.most <= 1 && r.spaced.rows.length === 1 && r.spaced.rows[0] === "act-06");
  console.log("SHOT:" + JSON.stringify({ results, ok }, null, 1));
  app.exit(ok ? 0 : 1);
});
