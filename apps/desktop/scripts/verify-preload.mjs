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
  setApprovalMode,
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
let relayGate = null; // when set, `settings:getRelay` blocks until released
/** Resolved BY the handler the moment a refresh actually parks on the gate. */
let relayEntered = () => {};
ipcMain.handle("settings:getRelay", async () => {
  if (relayGate) {
    relayEntered();
    await relayGate;
  }
  const s = loadSettings(probeHome);
  return {
    apiBaseUrl: "https://api.plow.co",
    accountUid: s.accountUid,
    mcpUrl: s.mcpUrl,
    hasCredential: !!(s.relayCredential ?? "").trim(),
    connected: true,
  };
});
ipcMain.handle("settings:setApprovalMode", async (_e, m) => setApprovalMode(probeHome, m));
ipcMain.handle("settings:getShowSuggestions", async () => true);
// These four are the real handlers, running the real guards against real
// on-disk settings. A signed-in Mac with no Anthropic key: Plow is usable and
// selected, the Anthropic provider is not.
ipcMain.handle("settings:getApiKey", async () => loadSettings(probeHome).anthropicApiKey ?? "");
ipcMain.handle("settings:setApiKey", async (_e, key) => setAnthropicApiKey(probeHome, key));
ipcMain.handle("settings:getInference", async () => readInference(probeHome));
ipcMain.handle("settings:setInference", async (_e, provider) =>
  setInferenceProvider(probeHome, provider),
);
// Connect a client: the same shape `ConnectClient.state()` returns, with no
// credential minted — the screen this probe renders is the OAuth one.
ipcMain.handle("connect:get", async () => ({
  mcpUrl: "https://api.plow.co/v1/relay/devices/u_probe/mcp",
  accountUid: "u_probe",
  connected: true,
  hasCredential: true,
  busy: false,
  message: "",
  credential: null,
}));
// A packaged-looking updater state so the Software Updates section renders
// its full form (status line, check button, both preference checkboxes).
ipcMain.handle("updates:get", async () => ({
  supported: true,
  currentVersion: "0.1.202608130900",
  autoCheck: true,
  autoInstall: true,
  phase: "idle",
  availableVersion: null,
  lastCheckAt: "2026-08-13T09:00:00.000Z",
  error: null,
  dismissed: false,
  upToDate: false,
}));
ipcMain.handle("settings:getApprovalMode", async () => "ask");
ipcMain.handle("settings:getReviewerInfo", async () => "probe-model");
// No browsing session: the audit screen's live thumbnail stays hidden.
ipcMain.handle("viewer:state", async () => ({
  active: false,
  origins: [],
  inScope: true,
  url: "",
  frame: null,
}));

// The approval window pulls one view model — the same shape approvalViewModel()
// produces from an intent.
ipcMain.handle("approval:get", async () => ({
  kind: "intent",
  suggesting: true,
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
      hasAccountGroup: document.body.innerText.includes("Plow Account"),
      // The only password field left is the Anthropic API key.
      offersNoRelayKeyField: !document.body.innerText.includes("Connect key"),
      bodyLeaksKey: /plow_sk|BEGIN|secret/i.test(document.body.innerText),
      // The new group, and its interlock: Plow has a credential so it is
      // selected; Anthropic has none so its chip is disabled.
      hasInferenceGroup: document.body.innerText.includes("Reviewer inference"),
      plowChipActive: !!plow && plow.classList.contains("active"),
      anthropicChipDisabled: !!anthropic && anthropic.classList.contains("disabled"),
      showsActiveModel: document.body.innerText.includes("anthropic/claude-sonnet-4-6"),
      // Settings has a `.reviewer-note` of its own. The approval window's
      // advice-card styling must not reach it — same class name, different
      // window, and the card rule is scoped through `.approve`.
      settingsNoteNotRestyled: (() => {
        const note = document.querySelector(".reviewer-note");
        if (!note) return false;
        const style = getComputedStyle(note);
        return style.padding === "0px" && style.display !== "flex";
      })(),
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

  // What used to sit here: a provider round-trip through the bridge, and a
  // mode-fallback check. Both asserted the interlock in `settingsActions`, and
  // both are covered by `test/settingsActions.test.ts`, which executes the same
  // guards against real on-disk settings — verified by mutation: dropping the
  // availability check, or the retire-to-Ask rule, fails those tests. What is
  // left below is what only a real renderer can show.

  // A half-typed key must not persist anything. The pane re-renders on the
  // committed value only, so drive it back to a known state first: Anthropic
  // selected, a real stored key, Adversarial mode.
  saveSettings(probeHome, {
    ...loadSettings(probeHome),
    relayCredential: "plow_sk_probe_credential",
    anthropicApiKey: "sk-ant-a-real-committed-key",
    inferenceProvider: "anthropic",
    approvalMode: "adversarial",
  });
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("settings")`);
  await new Promise((r) => setTimeout(r, 300));
  const modeBeforeTyping = loadSettings(probeHome).approvalMode;
  // Clear the field the way someone does before pasting a replacement: `input`
  // fires, `change` does not (no blur, no Enter). Nothing is committed, so
  // nothing may be persisted.
  await win.webContents.executeJavaScript(`(() => {
    const input = [...document.querySelectorAll("input")].find((i) => i.type === "password");
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const afterTransientInput = loadSettings(probeHome);
  const transientInput = {
    startedAdversarial: modeBeforeTyping === "adversarial",
    modeUntouched: afterTransientInput.approvalMode === "adversarial",
    storedKeyUntouched: afterTransientInput.anthropicApiKey === "sk-ant-a-real-committed-key",
  };

  // An open Settings pane must re-read when main says the account changed —
  // otherwise signing in leaves Plow showing as unavailable until a tab switch.
  saveSettings(probeHome, { ...loadSettings(probeHome), relayCredential: "", inferenceProvider: "anthropic" });
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("settings")`);
  await new Promise((r) => setTimeout(r, 300));
  const plowDisabledWhileSignedOut = await win.webContents.executeJavaScript(`(() => {
    const plow = [...document.querySelectorAll(".chip")].find((c) => c.textContent.trim() === "Plow account");
    return !!plow && plow.classList.contains("disabled");
  })()`);
  saveSettings(probeHome, { ...loadSettings(probeHome), relayCredential: "plow_sk_now_signed_in" });
  win.webContents.send("status:changed");
  await new Promise((r) => setTimeout(r, 500));
  const staleSettingsPane = {
    disabledWhileSignedOut: plowDisabledWhileSignedOut,
    enabledAfterStatusChanged: await win.webContents.executeJavaScript(`(() => {
      const plow = [...document.querySelectorAll(".chip")].find((c) => c.textContent.trim() === "Plow account");
      return !!plow && !plow.classList.contains("disabled");
    })()`),
  };

  // THE RACE, specifically: typing that starts while a status-driven refresh is
  // ALREADY IN FLIGHT and parked on one of its awaited reads. The dirty-flag
  // version sampled the flag before that read and replaced the field after it,
  // so a keystroke landing in between was lost. Hold `settings:getRelay` open,
  // type while the refresh is blocked on it, then release.
  await win.webContents.executeJavaScript(`(() => {
    const input = [...document.querySelectorAll("input")].find((i) => i.type === "password");
    input.value = "";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dataset.probeMark = "original-node";
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 300));

  let releaseRelay = () => {};
  relayGate = new Promise((r) => {
    releaseRelay = r;
  });
  // Waited on, not slept through: the handler resolves this the instant the
  // refresh reaches the gate, so the keystroke below lands mid-flight by
  // construction rather than by betting on 200ms being enough.
  const entered = new Promise((r) => {
    relayEntered = r;
  });
  saveSettings(probeHome, { ...loadSettings(probeHome), accountUid: "u_mid_flight" });
  win.webContents.send("status:changed"); // refresh starts, parks on relayGet
  await entered;
  await win.webContents.executeJavaScript(`(() => {
    const input = [...document.querySelectorAll("input")].find((i) => i.type === "password");
    input.value = "sk-ant-typed-mid-refresh";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  releaseRelay();
  relayGate = null;
  await new Promise((r) => setTimeout(r, 500));

  const midFlight = await win.webContents.executeJavaScript(`(() => {
    const input = [...document.querySelectorAll("input")].find((i) => i.type === "password");
    return {
      kept: input.value === "sk-ant-typed-mid-refresh",
      // The same DOM node, not a rebuilt one that happens to hold the value.
      sameNode: input.dataset.probeMark === "original-node",
      accountRefreshed: document.body.innerText.includes("u_mid_flight"),
    };
  })()`);
  await win.webContents.executeJavaScript(`(() => {
    const input = [...document.querySelectorAll("input")].find((i) => i.type === "password");
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const raceDuringRefresh = {
    ...midFlight,
    // The keystroke that arrived mid-refresh is what got committed.
    committed: loadSettings(probeHome).anthropicApiKey === "sk-ant-typed-mid-refresh",
  };

  // REPRO (c): the renderer's optimistic mode. Adversarial is offered while a
  // credential is present, so the chip is enabled and clickable — but the
  // credential can go between the render and the click, and main REFUSES. The
  // renderer assigned `currentMode` before asking, so it kept a selection main
  // had already turned down: the pane says Adversarial while disk says Ask.
  saveSettings(probeHome, {
    ...loadSettings(probeHome),
    relayCredential: "plow_sk_probe_credential",
    anthropicApiKey: "",
    inferenceProvider: "plow",
    approvalMode: "ask",
  });
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("settings")`);
  await new Promise((r) => setTimeout(r, 300));
  // The credential goes AFTER the pane rendered, with no notification — so the
  // chip is still enabled and the renderer still believes it can select this.
  saveSettings(probeHome, { ...loadSettings(probeHome), relayCredential: "" });
  await win.webContents.executeJavaScript(`(() => {
    const chip = [...document.querySelectorAll(".chip")].find((c) => c.textContent.trim() === "Adversarial Agent");
    chip.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const optimisticMode = {
    storedIsAsk: loadSettings(probeHome).approvalMode === "ask",
    // What the pane claims, after main said no.
    chipAgrees: await win.webContents.executeJavaScript(`(() => {
      const chip = [...document.querySelectorAll(".chip")].find((c) => c.textContent.trim() === "Adversarial Agent");
      return !!chip && !chip.classList.contains("active");
    })()`),
  };

  // Connect a client is Settings' FIRST group now, not a tab of its own — so
  // the probe reaches it through Settings, and also checks the ordering rather
  // than merely that the text is somewhere on the pane.
  //
  // Sign back in first: the optimistic-mode repro above deliberately left the
  // account signed OUT, and this subsection is about a signed-in Mac (it is
  // what `connect:get` stubs). Probing it signed out would assert nothing.
  saveSettings(probeHome, { ...loadSettings(probeHome), relayCredential: "plow_sk_probe_credential" });
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("settings")`);
  await new Promise((r) => setTimeout(r, 300));
  const connect = await win.webContents.executeJavaScript(`(${() => {
    const text = document.body.innerText;
    const titles = [...document.querySelectorAll(".settings .item > .group-title")].map((t) =>
      t.textContent.trim(),
    );
    const group = [...document.querySelectorAll(".settings .item")].find(
      (i) => i.querySelector(".group-title")?.textContent.trim() === "Connect a client",
    );
    return {
      showsUrl: text.includes("https://api.plow.co/v1/relay/devices/u_probe/mcp"),
      showsOauth: text.includes("Sign in with OAuth"),
      offersFallback: text.includes("Can't use OAuth"),
      // The move itself: the content is its own FIRST group, Plow Account
      // follows it, and the tab it used to have is gone from the titlebar.
      inOwnGroup: !!group?.querySelector(".connect"),
      groupOrder: titles.slice(0, 2).join(" > ") === "Connect a client > Plow Account",
      groupTitles: titles,
      noConnectTab: !document.querySelector('#seg button[data-tab="connect"]'),
      // The probe's account IS signed in, so Sign In must not be on screen.
      // `hidden` alone does not hide a `display: inline-flex` button, and the
      // result is a Sign In sitting beside Sign Out on a live account.
      noSignInWhileSignedIn: ![...document.querySelectorAll("button")].some(
        (b) => b.textContent.trim() === "Sign In" && getComputedStyle(b).display !== "none",
      ),
    };
  }})()`);

  fs.rmSync(probeHome, { recursive: true, force: true });

  const approvalWin = offscreen();
  // The defect this guards: an adversarial fallback hands over an ALREADY
  // RESOLVED hint, so main used to send it before the renderer had installed
  // its listener and it was lost outright. Resolve it here, before loadFile is
  // even called, and register the real handshake the way main does.
  const hint = Promise.resolve({ decision: null, reason: "insufficient Plow balance" });
  let markReady = () => {};
  const ready = new Promise((r) => {
    markReady = r;
  });
  ipcMain.handle("approval:ready", async () => markReady());
  void Promise.all([hint, ready]).then(([said]) =>
    approvalWin.webContents.send("approval:suggestion", { id: "probe-intent", ...said }),
  );

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

  const reviewerNote = await approvalWin.webContents.executeJavaScript(`(${() => {
    const note = document.querySelector(".reviewer-note");
    const fine = document.querySelector(".fine");
    return {
      showsReason: (note?.textContent ?? "").includes("insufficient Plow balance"),
      // Advice, and labelled as such.
      labelledAsAdvice: (note?.textContent ?? "").includes("advice only"),
      // …and OUTSIDE the enforceable-bound block, which must still show only
      // the capability set.
      outsideEnforcedBlock: !!fine && !fine.contains(note),
      enforcedBlockUnchanged: (fine?.textContent ?? "").includes("run ls"),
      // Inserted as text, never markup.
      noMarkupInjected: !(note?.innerHTML ?? "").includes("<script"),
      // …and the "Reviewing…" spinner is gone, not spinning forever.
      spinnerCleared: !document.querySelector(".reviewing-spinner"),
      // End of the chain: whatever a reason says, nothing credential-shaped may
      // be drawn here. The guard is upstream in the provider; this is the last
      // place to notice if it ever stops holding.
      leaksCredential: /plow_sk|sk-ant|Bearer /i.test(note?.textContent ?? ""),
    };
  }})()`);

  const ok =
    connect.showsUrl &&
    connect.showsOauth &&
    connect.offersFallback &&
    connect.inOwnGroup &&
    connect.groupOrder &&
    connect.noConnectTab &&
    connect.noSignInWhileSignedIn &&
    settings.hasAccountGroup &&
    settings.offersNoRelayKeyField &&
    !settings.bodyLeaksKey &&
    settings.hasInferenceGroup &&
    settings.plowChipActive &&
    settings.anthropicChipDisabled &&
    settings.showsActiveModel &&
    settings.settingsNoteNotRestyled &&
    transientInput.startedAdversarial &&
    transientInput.modeUntouched &&
    transientInput.storedKeyUntouched &&
    staleSettingsPane.disabledWhileSignedOut &&
    staleSettingsPane.enabledAfterStatusChanged &&
    raceDuringRefresh.kept &&
    raceDuringRefresh.sameNode &&
    raceDuringRefresh.accountRefreshed &&
    raceDuringRefresh.committed &&
    optimisticMode.storedIsAsk &&
    optimisticMode.chipAgrees &&
    main.hasBridge &&
    main.viewChildren > 0 &&
    approval.showsCapability &&
    approval.buttons.length > 0 &&
    reviewerNote.showsReason &&
    reviewerNote.labelledAsAdvice &&
    reviewerNote.outsideEnforcedBlock &&
    reviewerNote.enforcedBlockUnchanged &&
    reviewerNote.noMarkupInjected &&
    reviewerNote.spinnerCleared &&
    !reviewerNote.leaksCredential &&
    errors.length === 0;
  console.log(
    "PROBE:" +
      JSON.stringify({ main, settings, connect, transientInput, staleSettingsPane, raceDuringRefresh, optimisticMode, settingsShot, approval, reviewerNote, consoleErrors: errors, ok }),
  );
  app.exit(ok ? 0 : 1);
});
