// Headless verification that the sandboxed preload actually exposes window.domo
// and both renderers — the main window AND the approval window — can render
// without throwing. Loads the REAL html with the REAL preload.cjs in offscreen
// windows, then reads back the DOM state.
// Run: DOMO_HOME=/tmp/x npx electron apps/desktop/scripts/verify-preload.mjs
import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The REAL settings actions, so the inference handlers below are the ones the
// app runs rather than stubs that agree with the renderer by construction.
import {
  readInference,
  setAnthropicApiKey,
  setInferenceProvider,
} from "../dist/settingsActions.js";
import { loadSettings, saveSettings } from "../dist/settings.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");

// A throwaway home for the round-trip checks: signed in to Plow, no Anthropic
// key, so exactly one provider is selectable.
const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), "domo-probe-"));
saveSettings(probeHome, {
  ...loadSettings(probeHome),
  relayCredential: "plow_sk_probe_credential",
  accountUid: "u_probe",
  inferenceProvider: "plow",
  approvalMode: "adversarial",
});

// Stub the IPC handlers the renderer calls on load, so this probe needs no
// device — we're testing the bridge + render path, not the data.
ipcMain.handle("audit:activities", async () => []);
ipcMain.handle("status:get", async () => ({ deviceId: "probe", name: "Probe", connected: false }));
ipcMain.handle("goals:list", async () => []);
ipcMain.handle("rules:list", async () => []);
ipcMain.handle("ui:getTab", async () => "audit");
ipcMain.handle("ui:setTab", async () => {});
// A signed-in Mac: the credential itself is deliberately absent from this
// shape, because the main process never hands it to the renderer.
ipcMain.handle("settings:getRelay", async () => ({
  apiBaseUrl: "https://api.plow.co",
  accountUid: "u_probe",
  mcpUrl: "https://api.plow.co/v1/relay/devices/u_probe/mcp",
  hasCredential: true,
  connected: true,
}));
ipcMain.handle("settings:getApprovalMode", async () => "ask");
ipcMain.handle("settings:getShowSuggestions", async () => true);
ipcMain.handle("settings:getReviewerInfo", async () => "probe-model");
// These four are the real handlers, running the real guards against real
// on-disk settings. A signed-in Mac with no Anthropic key: Plow is usable and
// selected, the Anthropic provider is not.
ipcMain.handle("settings:getApiKey", async () => loadSettings(probeHome).anthropicApiKey ?? "");
ipcMain.handle("settings:setApiKey", async (_e, key) => setAnthropicApiKey(probeHome, key));
ipcMain.handle("settings:getInference", async () => readInference(probeHome));
ipcMain.handle("settings:setInference", async (_e, provider) =>
  setInferenceProvider(probeHome, provider),
);

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
      // A hidden window throttles rendering, so capturePage() hands back the
      // last frame it happened to paint — which made the screenshots below show
      // whichever tab was up at load time, no matter what the DOM said.
      backgroundThrottling: false,
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

  // Settings names the Plow account, so render it too and prove the credential
  // never reaches the renderer. There is no key field and no URL field any more:
  // the credential is minted by first-run login and the API origin is baked into
  // the build.
  await win.webContents.executeJavaScript(`window.__domoSelectTab && window.__domoSelectTab("settings")`);
  await new Promise((r) => setTimeout(r, 300));
  const settings = await win.webContents.executeJavaScript(`(${() => {
    const chip = (label) =>
      [...document.querySelectorAll(".chip")].find((c) => c.textContent.trim() === label);
    const plow = chip("Plow account");
    const anthropic = chip("Anthropic API key");
    return {
      hasAccountGroup: document.body.innerText.includes("Plow account"),
      // The only password field left is the Anthropic API key.
      offersNoRelayKeyField: !document.body.innerText.includes("Connect key"),
      bodyLeaksKey: /plow_sk|BEGIN|secret/i.test(document.body.innerText),
      // The new group, and its interlock: Plow has a credential so it is
      // selected; Anthropic has none so its chip is disabled.
      hasInferenceGroup: document.body.innerText.includes("Reviewer inference"),
      plowChipActive: !!plow && plow.classList.contains("active"),
      anthropicChipDisabled: !!anthropic && anthropic.classList.contains("disabled"),
      showsActiveModel: document.body.innerText.includes("anthropic/claude-sonnet-4-6"),
    };
  }})()`);

  // Settings changed with first-run login, and every UI change gets an image.
  // Wait for two frames to actually land before capturing, so the image is the
  // pane we just asserted on rather than whatever was painted before it.
  const settingsShot = process.env.SETTINGS_OUT ?? "/tmp/settings-account.png";
  await win.webContents.executeJavaScript(
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))`,
  );
  fs.writeFileSync(settingsShot, (await win.webContents.capturePage()).toPNG());

  // The interlock, driven end to end from the sandboxed renderer: bridge →
  // ipcMain → the real guard → disk. `inferenceSet` is called directly rather
  // than by clicking, because the UI does not even attach a click handler to a
  // disabled chip — the point here is that a call the renderer *could* make
  // anyway is refused by the main process, not merely hidden.
  const roundTrip = await win.webContents.executeJavaScript(`(async () => {
    const refused = await window.domo.inferenceSet("anthropic");
    const junk = await window.domo.inferenceSet("openai");
    // Now give it a key, the way the settings pane does, and try again.
    await window.domo.apiKeySet("sk-ant-probe");
    const accepted = await window.domo.inferenceSet("anthropic");
    return {
      refusedStaysOnPlow: refused.provider === "plow" && refused.anthropicAvailable === false,
      junkStaysOnPlow: junk.provider === "plow",
      acceptedSwitches: accepted.provider === "anthropic" && accepted.anthropicAvailable === true,
      // The status shape never carries a credential.
      leaksCredential: JSON.stringify([refused, junk, accepted]).includes("plow_sk"),
    };
  })()`);

  // And the mode fallback survives the same round trip: the probe home starts
  // in Adversarial on Plow, so clearing Plow's credential must retire it.
  const before = loadSettings(probeHome).approvalMode;
  setInferenceProvider(probeHome, "plow");
  saveSettings(probeHome, { ...loadSettings(probeHome), relayCredential: "" });
  await win.webContents.executeJavaScript(`window.domo.apiKeySet("")`);
  const modeFallback = {
    startedAdversarial: before === "adversarial",
    retiredToAsk: loadSettings(probeHome).approvalMode === "ask",
  };
  fs.rmSync(probeHome, { recursive: true, force: true });

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
    settings.hasAccountGroup &&
    settings.offersNoRelayKeyField &&
    !settings.bodyLeaksKey &&
    settings.hasInferenceGroup &&
    settings.plowChipActive &&
    settings.anthropicChipDisabled &&
    settings.showsActiveModel &&
    roundTrip.refusedStaysOnPlow &&
    roundTrip.junkStaysOnPlow &&
    roundTrip.acceptedSwitches &&
    !roundTrip.leaksCredential &&
    modeFallback.startedAdversarial &&
    modeFallback.retiredToAsk &&
    main.hasBridge &&
    main.viewChildren > 0 &&
    approval.showsCapability &&
    approval.buttons.length > 0 &&
    errors.length === 0;
  console.log(
    "PROBE:" +
      JSON.stringify({ main, settings, roundTrip, modeFallback, settingsShot, approval, consoleErrors: errors, ok }),
  );
  app.exit(ok ? 0 : 1);
});
