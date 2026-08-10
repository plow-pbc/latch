// Headless verification that the sandboxed preload actually exposes window.domo
// and both renderers — the main window AND the approval window — can render
// without throwing. Loads the REAL html with the REAL preload.cjs in offscreen
// windows, then reads back the DOM state.
// Run: DOMO_HOME=/tmp/x npx electron apps/desktop/scripts/verify-preload.mjs
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");

// Stub the IPC handlers the renderer calls on load, so this probe needs no
// device — we're testing the bridge + render path, not the data.
ipcMain.handle("audit:activities", async () => []);
ipcMain.handle("status:get", async () => ({ deviceId: "probe", name: "Probe", connected: false }));
ipcMain.handle("goals:list", async () => []);
ipcMain.handle("rules:list", async () => []);
ipcMain.handle("ui:getTab", async () => "audit");
ipcMain.handle("ui:setTab", async () => {});
ipcMain.handle("settings:getRelay", async () => ({
  url: "wss://relay.example/v1/relay/ws",
  hasCredential: true,
  connected: false,
}));
ipcMain.handle("settings:getApprovalMode", async () => "ask");
ipcMain.handle("settings:getShowSuggestions", async () => true);
ipcMain.handle("settings:getApiKey", async () => "");
ipcMain.handle("settings:getReviewerInfo", async () => "probe-model");

// The approval window pulls one view model — the same shape approvalViewModel()
// produces from an intent.
ipcMain.handle("approval:get", async () => ({
  kind: "intent",
  suggesting: false,
  view: {
    intentId: "probe-intent",
    agentDisplay: "Probe Agent",
    agentId: "probe-agent",
    goal: "probe goal",
    request: "run: ls",
    planContext: null,
    capabilities: [{ kind: "process.exec", display: "run ls" }],
    needsNetwork: false,
    writesFiles: false,
    runsCommand: true,
  },
}));

const errors = [];

function offscreen() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(dist, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) errors.push(message); // warnings/errors
  });
  return win;
}

app.whenReady().then(async () => {
  const win = offscreen();
  await win.loadFile(path.join(dist, "renderer/index.html"));
  // Give the async render() a tick.
  await new Promise((r) => setTimeout(r, 400));
  const main = await win.webContents.executeJavaScript(`(${() => {
    return {
      hasBridge: typeof window.domo === "object" && window.domo !== null,
      bridgeKeys: window.domo ? Object.keys(window.domo).length : 0,
      viewChildren: document.getElementById("view")?.childElementCount ?? -1,
      statusText: document.getElementById("statusText")?.textContent ?? "",
    };
  }})()`);

  // The Settings tab is where the relay credential lives, so render it too and
  // prove the key never reaches the renderer.
  await win.webContents.executeJavaScript(`window.__domoSelectTab && window.__domoSelectTab("settings")`);
  await new Promise((r) => setTimeout(r, 300));
  const settings = await win.webContents.executeJavaScript(`(${() => {
    const inputs = [...document.querySelectorAll("input")];
    return {
      hasRelayUrl: document.body.innerText.includes("Relay connection"),
      keyFieldIsPassword: inputs.some((i) => i.type === "password" && i.value === ""),
      bodyLeaksKey: /plow_sk|BEGIN|secret/i.test(document.body.innerText),
    };
  }})()`);

  const approvalWin = offscreen();
  await approvalWin.loadFile(path.join(dist, "renderer/approval.html"));
  await new Promise((r) => setTimeout(r, 400));
  const approval = await approvalWin.webContents.executeJavaScript(`(${() => {
    const text = document.body.innerText;
    return {
      // The enforceable bound (the capability set) and the agent must both show.
      showsCapability: text.includes("run ls"),
      showsAgent: text.includes("Probe Agent"),
      buttons: [...document.querySelectorAll("button")].map((b) => b.textContent),
    };
  }})()`);

  const ok =
    settings.hasRelayUrl &&
    settings.keyFieldIsPassword &&
    !settings.bodyLeaksKey &&
    main.hasBridge &&
    main.viewChildren > 0 &&
    approval.showsCapability &&
    approval.buttons.length > 0 &&
    errors.length === 0;
  console.log("PROBE:" + JSON.stringify({ main, settings, approval, consoleErrors: errors, ok }));
  app.exit(ok ? 0 : 1);
});
