// Headless verification that the sandboxed preload actually exposes window.domo
// and the renderer can render without throwing. Loads the REAL index.html with
// the REAL preload.cjs in an offscreen window, then reads back the DOM state.
// Run: DOMO_HOME=/tmp/x npx electron apps/desktop/scripts/verify-preload.mjs
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");

// Stub the IPC handlers the renderer calls on load, so this probe needs no
// broker/device — we're testing the bridge + render path, not the data.
ipcMain.handle("audit:rows", async () => []);
ipcMain.handle("status:get", async () => ({ deviceId: "probe", name: "Probe", connected: false }));
ipcMain.handle("goals:list", async () => []);
ipcMain.handle("rules:list", async () => []);
ipcMain.handle("agents:list", async () => []);
ipcMain.handle("settings:get", async () => ({ brokerConnection: "" }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(dist, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const errors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) errors.push(message); // warnings/errors
  });
  await win.loadFile(path.join(dist, "renderer/index.html"));
  // Give the async render() a tick.
  await new Promise((r) => setTimeout(r, 400));
  const result = await win.webContents.executeJavaScript(`(${() => {
    return {
      hasBridge: typeof window.domo === "object" && window.domo !== null,
      bridgeKeys: window.domo ? Object.keys(window.domo).length : 0,
      viewChildren: document.getElementById("view")?.childElementCount ?? -1,
      statusText: document.getElementById("statusText")?.textContent ?? "",
    };
  }})()`);
  console.log("PROBE:" + JSON.stringify({ ...result, consoleErrors: errors }));
  app.exit(result.hasBridge && result.viewChildren > 0 ? 0 : 1);
});
