// Render the REAL main window's Agents tab offscreen, with the REAL preload and
// the REAL `ConnectClient` state machine, and capture one PNG per state. Like
// onboarding-screenshot.mjs, it EXITS NON-ZERO if a screen is missing the
// content it exists to show.
//
// The flow this shoots has moved (a "Connect a client" tab, a Settings group,
// now the Agents tab) and its copy has been rewritten with it. That is what
// this script is for: the expectations below are the copy, so a change to it
// that nobody meant fails here rather than shipping.
//
//   just connect-screenshot              → /tmp/connect-*.png
//   OUT_DIR=/path just connect-screenshot
//
// What is stood in for is Plow and nothing else: the module under the screen is
// the shipping one, driven against a throwaway DOMO_HOME whose settings.json
// holds an obviously-fake device credential. So the URL on screen comes from
// settings the way it does in the app, and the credential in the copy-once
// block was really minted by `ConnectClient` — from a fake mint, but through
// the real path.
import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");
const outDir = process.env.OUT_DIR ?? "/tmp";

const MCP_URL = "https://api.plow.co/v1/relay/devices/u_7Qk2p9/mcp";
// Both of these are the shape of a real credential and the substance of none.
// The device one is written to a throwaway home; the client one is what the
// fake mint hands back, so the copy-once block has something to show.
const DEVICE_TOKEN = "plow_EXAMPLEdeviceNOTreal_00000";
const CLIENT_TOKEN = "plow_EXAMPLEclientNOTreal_00000";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "connect-shot-"));

// Nothing is imported or registered at the top level: Electron does not emit
// `ready` until this entry module finishes evaluating, and a top-level await
// makes that a race nobody wants to debug. `setUp` runs inside whenReady.
const DEVICE_SETTINGS = { relayCredential: DEVICE_TOKEN, accountUid: "u_7Qk2p9", mcpUrl: MCP_URL };

async function setUp() {
  const { ConnectClient } = await import(path.join(dist, "connectClient.js"));
  const { saveSettings, loadSettings } = await import(path.join(dist, "settings.js"));

  // A Mac that has been through login: a device credential and an endpoint.
  saveSettings(home, { ...loadSettings(home), ...DEVICE_SETTINGS });

  /** Plow, stood in for — the one call this screen can make. */
  const api = {
    async createAgent(token, name) {
      if (token !== DEVICE_TOKEN) throw new Error("the mint must use the device credential");
      return { token: CLIENT_TOKEN, keyPrefix: CLIENT_TOKEN.slice(5, 13), name };
    },
  };

  const connect = new ConnectClient({ api, home, isConnected: () => true });

  // The main window's IPC surface, as far as this screen reaches. `connect:*`
  // are the real handlers from main.ts, pointed at the same class.
  ipcMain.handle("connect:get", async () => connect.state());
  ipcMain.handle("connect:create", async (_e, name) => connect.createCredential(name));
  ipcMain.handle("connect:dismiss", async () => connect.dismissCredential());
  ipcMain.handle("status:get", async () => ({ deviceId: "dev_example", name: "Example Mac", connected: true }));
  ipcMain.handle("ui:getTab", async () => "agents");
  ipcMain.handle("ui:setTab", async () => {});
  // The main window's boot also asks for the update banner's state; without a
  // handler the invoke rejects and the renderer never finishes booting.
  ipcMain.handle("updates:get", async () => ({
    supported: false,
    currentVersion: "0.0.0-shot",
    autoCheck: false,
    autoInstall: false,
    phase: "idle",
    availableVersion: null,
    lastCheckAt: null,
    error: null,
    dismissed: false,
    upToDate: false,
  }));
  return connect;
}

/** Each shot: how to get the screen into that state, and what must be on it. */
const SCREENS = [
  {
    name: "oauth",
    prepare: async () => {},
    expect: [
      "Connect an MCP client",
      "Add this server URL to Claude Code, Codex, Cursor",
      MCP_URL,
      // Signing in is not a step any more, but the reassurance still has to be
      // on screen — it is the reason OAuth is the route.
      "signs in with OAuth the first time it connects",
      "no token to copy, store, or rotate",
      // The shortcut to where the URL gets pasted.
      "Claude",
      "Can't use OAuth? Create a static credential",
    ],
  },
  {
    // The form is a MODAL now, not an inline expander — same click, same
    // fields, over the pane instead of inside it.
    name: "static-form",
    prepare: async (win) => clickText(win, "Can't use OAuth"),
    expect: ["Static credential", "Name this connection", "Create Credential", "Cancel"],
  },
  {
    name: "static-shown",
    prepare: async (win) => {
      await clickText(win, "Can't use OAuth");
      await type(win, `input[placeholder="Claude Code"]`, "Claude Code");
      await clickText(win, "Create Credential");
    },
    // The credential and its "I've Saved It" button are the point of this
    // screen, and they can sit below the fold in a 620pt window. Scroll to
    // them, or the picture shows everything except the thing it is evidence of.
    // The modal scrolls itself now, so that is what gets scrolled when it is up.
    scrollToBottom: true,
    expect: [
      "Paste this into Claude Code",
      "shown once and cannot be shown again",
      CLIENT_TOKEN,
      "mcpServers",
      "I've Saved It",
    ],
  },
];

/** Click by visible label, the way a person picks a button out of the page. */
async function clickText(win, label) {
  const found = await win.webContents.executeJavaScript(`
    (() => {
      const el = [...document.querySelectorAll("button")]
        .find((b) => b.textContent.includes(${JSON.stringify(label)}));
      if (!el) return false;
      el.click();
      return true;
    })()
  `);
  if (!found) throw new Error(`no button labelled ${label}`);
  await new Promise((r) => setTimeout(r, 250));
}

async function type(win, selector, text) {
  const found = await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.value = ${JSON.stringify(text)};
      return true;
    })()
  `);
  if (!found) throw new Error(`no field matching ${selector}`);
}

process.on("unhandledRejection", (error) => {
  console.error("SHOT-FAILED:", error);
  app.exit(1);
});

app.whenReady().then(async () => {
  const connect = await setUp();
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({
    width: 940,
    height: 620,
    show: false,
    webPreferences: {
      preload: path.join(dist, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  let failures = 0;
  for (const screen of SCREENS) {
    // A reload re-runs the renderer's boot, which restores the Agents tab — and
    // drops any modal left standing by the screen before it.
    await win.loadFile(path.join(dist, "renderer/index.html"));
    await new Promise((r) => setTimeout(r, 400));
    await screen.prepare(win);
    if (screen.scrollToBottom) {
      await win.webContents.executeJavaScript(
        `(() => { const p = document.querySelector(".modal") ?? document.querySelector(".panel"); if (p) p.scrollTop = p.scrollHeight; })()`,
      );
      await new Promise((r) => setTimeout(r, 200));
    }

    const out = path.join(outDir, `connect-${screen.name}.png`);
    fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());

    const text = await win.webContents.executeJavaScript("document.body.innerText");
    const missing = screen.expect.filter((needle) => !text.includes(needle));
    if (missing.length) failures += 1;
    console.log("SHOT:" + JSON.stringify({ screen: screen.name, out, missing }));

    // Copy-once is a claim about the app, so the run checks it rather than
    // leaving it to the picture: once dismissed, the config is gone for good.
    if (screen.name === "static-shown") {
      connect.dismissCredential();
      const after = JSON.stringify(connect.state());
      if (after.includes(CLIENT_TOKEN)) {
        failures += 1;
        console.log("SHOT:" + JSON.stringify({ screen: "copy-once", missing: ["credential survived dismissal"] }));
      }
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
  app.exit(failures === 0 ? 0 : 1);
});
