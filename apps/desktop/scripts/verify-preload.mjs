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
ipcMain.handle("rules:list", async () => []);
ipcMain.handle("ui:getTab", async () => "audit");
ipcMain.handle("ui:setTab", async () => {});
// A signed-in Mac: the credential itself is deliberately absent from this
// shape, because the main process never hands it to the renderer.
let relayGate = null; // when set, `settings:getRelay` blocks until released
/** Flipped by the mid-flight test: the one account-group value a refresh still
 *  visibly changes, now that the endpoint and UID rows are gone. */
let relayConnected = true;
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
    connected: relayConnected,
  };
});
ipcMain.handle("settings:setApprovalMode", async (_e, m) => setApprovalMode(probeHome, m));
ipcMain.handle("settings:getShowSuggestions", async () => true);
// A Mac that has NOT granted Full Disk Access — the state the Capabilities
// section exists to explain.
ipcMain.handle("capabilities:get", async () => ({ fullDiskAccess: false }));
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
// A vault whose key has moved: the account is on disk and cannot be opened.
// This is what a Keychain reset, a restore from backup, or an app rename leaves
// behind, and it must not be reported as an empty vault.
ipcMain.handle("vault:get", async () => ({ status: "locked", reason: "undecryptable" }));
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

/**
 * Wait until the page says the thing is true, instead of guessing how long it
 * takes. Every fixed sleep that gated an assertion was a flake with a timer on
 * it: fast enough on a warm Mac, not on a loaded CI runner, and silently
 * asserting on a half-rendered pane when it lost. `capturePage()` still gets
 * its explicit frame waits — those are about paint, not state, and a poll
 * cannot see paint.
 */
async function waitFor(target, expr, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = await target.webContents.executeJavaScript(`!!(${expr})`);
    } catch {
      ok = false; // the page is mid-navigation; try again
    }
    if (ok) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The same idea for a condition in this process rather than the page. */
async function waitForNode(predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

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
  await waitFor(win, `window.domo && document.getElementById("view")?.childElementCount > 0`,
    "the main window to boot its bridge and render a pane");
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
  await waitFor(win, `document.querySelector(".panel.settings") && document.querySelectorAll(".chip").length > 0`,
    "the Settings pane and its provider chips");
  const settings = await win.webContents.executeJavaScript(`(${() => {
    const chip = (label) =>
      [...document.querySelectorAll(".chip")].find((c) => c.textContent.trim() === label);
    const plow = chip("Plow account");
    const anthropic = chip("Anthropic API key");
    return {
      hasAccountGroup: document.body.innerText.includes("Plow Account"),
      // The account group is about this Mac now, not the wire. The endpoint is
      // the Agents tab's job (where it can be copied) and the UID was noise.
      showsThisMac: document.querySelector("#view").innerText.includes("This Mac"),
      noEndpointRow: !document.querySelector("#view").innerText.includes("Agent endpoint"),
      noAccountUid: !document.querySelector("#view").innerText.includes("u_probe"),
      noPhonePromise: !document.querySelector("#view").innerText.includes("phone number"),
      // A faded chip must say what would un-fade it, and be the way there.
      explainsDisabledProvider: (document.querySelector(".reviewer-note")?.textContent ?? "").includes(
        "Anthropic API key: add one below to select it",
      ),
      // …and it must not repeat the chip's own label back at itself.
      hintDoesNotStutter: !(document.querySelector(".reviewer-note")?.textContent ?? "").includes(
        "Anthropic API key needs an Anthropic API key",
      ),
      disabledChipIsActionable: !!(() => {
        const chip = [...document.querySelectorAll(".chip")].find(
          (c) => c.textContent.trim() === "Anthropic API key",
        );
        return chip && chip.classList.contains("disabled") && chip.classList.contains("actionable");
      })(),
      // The only password field left is the Anthropic API key.
      offersNoRelayKeyField: !document.body.innerText.includes("Connect key"),
      bodyLeaksKey: /plow_sk|BEGIN|secret/i.test(document.body.innerText),
      // The new group, and its interlock: Plow has a credential so it is
      // selected; Anthropic has none so its chip is disabled.
      hasInferenceGroup: document.body.innerText.includes("Reviewer inference"),
      // The Capabilities section, on a Mac whose probe says denied: it names
      // the permission, says so honestly, gives the Messages use case, and
      // routes the grant through System Settings (a key into main's table —
      // the renderer never holds the URL).
      hasCapabilitiesGroup: document.body.innerText.includes("Capabilities"),
      fdaSaysNotGranted:
        document.body.innerText.includes("Full Disk Access") &&
        document.body.innerText.includes("Not granted"),
      fdaNamesMessages: document.body.innerText.includes("texted to you in Messages"),
      fdaOffersSystemSettings: [...document.querySelectorAll("button")].some(
        (b) => b.textContent.trim() === "Open System Settings",
      ),
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

  // …and the chip rows, scrolled to, because the explanation is the point of
  // this change and it sits below the account group.
  const chipsShot = process.env.CHIPS_OUT ?? "/tmp/settings-chips.png";
  await win.webContents.executeJavaScript(`(() => {
    const chips = [...document.querySelectorAll(".settings .item > .group-title")]
      .find((t) => t.textContent.trim() === "Reviewer inference");
    chips?.scrollIntoView({ block: "start" });
    return true;
  })()`);
  await win.webContents.executeJavaScript(
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))`,
  );
  fs.writeFileSync(chipsShot, (await win.webContents.capturePage()).toPNG());

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
  await waitFor(win, `[...document.querySelectorAll("input")].some((i) => i.type === "password")`,
    "the Settings pane's API-key field");
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
  // No condition to poll for: the assertion is that nothing was written. A
  // settle window is the only way to give a write the chance to happen.
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
  await waitFor(win, `[...document.querySelectorAll(".chip")].some((c) => c.textContent.trim() === "Plow account" && c.classList.contains("disabled"))`,
    "the Plow provider chip to go disabled while signed out");
  const plowDisabledWhileSignedOut = await win.webContents.executeJavaScript(`(() => {
    const plow = [...document.querySelectorAll(".chip")].find((c) => c.textContent.trim() === "Plow account");
    return !!plow && plow.classList.contains("disabled");
  })()`);
  saveSettings(probeHome, { ...loadSettings(probeHome), relayCredential: "plow_sk_now_signed_in" });
  win.webContents.send("status:changed");
  await waitFor(win, `[...document.querySelectorAll(".chip")].some((c) => c.textContent.trim() === "Plow account" && !c.classList.contains("disabled"))`,
    "the open Settings pane to re-read the account and re-enable Plow");
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
  await waitFor(win, `document.querySelector('input[data-probe-mark="original-node"]')`,
    "the marked key field to be the one on screen");

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
  // Something the refresh will visibly change. The account UID used to be that
  // marker; the group shows "This Mac" now, which a refresh does not alter, so
  // the connection line is the honest observable.
  relayConnected = false;
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
  await waitFor(win, `document.body.innerText.includes("Not connected")`,
    "the parked refresh to finish and redraw the connection line");

  const midFlight = await win.webContents.executeJavaScript(`(() => {
    const input = [...document.querySelectorAll("input")].find((i) => i.type === "password");
    return {
      kept: input.value === "sk-ant-typed-mid-refresh",
      // The same DOM node, not a rebuilt one that happens to hold the value.
      sameNode: input.dataset.probeMark === "original-node",
      // The parked refresh did land: the account group followed the flipped
      // connection state rather than staying on the value it rendered before.
      accountRefreshed: document.body.innerText.includes("Not connected"),
    };
  })()`);
  await win.webContents.executeJavaScript(`(() => {
    const input = [...document.querySelectorAll("input")].find((i) => i.type === "password");
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await waitForNode(() => loadSettings(probeHome).anthropicApiKey === "sk-ant-typed-mid-refresh",
    "the mid-refresh keystroke to be committed to settings.json");
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
  await waitFor(win, `[...document.querySelectorAll(".chip")].some((c) => c.textContent.trim() === "Adversarial Agent" && !c.classList.contains("disabled"))`,
    "the Adversarial chip to render enabled");
  // The credential goes AFTER the pane rendered, with no notification — so the
  // chip is still enabled and the renderer still believes it can select this.
  saveSettings(probeHome, { ...loadSettings(probeHome), relayCredential: "" });
  await win.webContents.executeJavaScript(`(() => {
    const chip = [...document.querySelectorAll(".chip")].find((c) => c.textContent.trim() === "Adversarial Agent");
    chip.click();
    return true;
  })()`);
  await waitFor(win, `[...document.querySelectorAll(".chip")].some((c) => c.textContent.trim() === "Adversarial Agent" && !c.classList.contains("active"))`,
    "the pane to follow main's refusal of Adversarial");
  const optimisticMode = {
    storedIsAsk: loadSettings(probeHome).approvalMode === "ask",
    // What the pane claims, after main said no.
    chipAgrees: await win.webContents.executeJavaScript(`(() => {
      const chip = [...document.querySelectorAll(".chip")].find((c) => c.textContent.trim() === "Adversarial Agent");
      return !!chip && !chip.classList.contains("active");
    })()`),
  };

  // Connecting a client lives in the Agents tab — first in the bar — and no
  // longer in Settings at all. Two checks, one per pane: Settings must be clean
  // of it, and Agents must render the whole flow.
  //
  // Sign back in first: the optimistic-mode repro above deliberately left the
  // account signed OUT, and this flow is about a signed-in Mac (it is what
  // `connect:get` stubs). Probing it signed out would assert nothing.
  saveSettings(probeHome, { ...loadSettings(probeHome), relayCredential: "plow_sk_probe_credential" });
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("settings")`);
  await waitFor(win, `document.querySelector(".settings .item > .group-title")?.textContent.trim() === "Plow Account"`,
    "Settings to remount with Plow Account first");
  const settingsPane = await win.webContents.executeJavaScript(`(${() => {
    const titles = [...document.querySelectorAll(".settings .item > .group-title")].map((t) =>
      t.textContent.trim(),
    );
    return {
      // Settings went back to what it was: Plow Account first, and not a trace
      // of the connect flow — no stub, no duplicate, no pointer.
      firstGroupIsAccount: titles[0] === "Plow Account",
      noConnectBlock: !document.querySelector("#view .connect"),
      noConnectText: !document.body.innerText.includes("Connect an MCP client"),
      groupTitles: titles,
      // The probe's account IS signed in, so Sign In must not be on screen.
      // `hidden` alone does not hide a `display: inline-flex` button, and the
      // result is a Sign In sitting beside Sign Out on a live account.
      noSignInWhileSignedIn: ![...document.querySelectorAll("button")].some(
        (b) => b.textContent.trim() === "Sign In" && getComputedStyle(b).display !== "none",
      ),
    };
  }})()`);

  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  await waitFor(win, `document.querySelector("#view .panel.agents .connect .client-card")`,
    "the Agents pane and its client card");
  const connect = await win.webContents.executeJavaScript(`(${() => {
    const text = document.body.innerText;
    const tabs = [...document.querySelectorAll("#seg button")].map((b) => b.dataset.tab);
    return {
      showsUrl: text.includes("https://api.plow.co/v1/relay/devices/u_probe/mcp"),
      // OAuth is no longer a numbered step — it is a reassurance inside the
      // flow's own prose. Same coverage, retargeted at the sentence.
      showsOauth: text.includes("signs in with OAuth the first time it connects"),
      // One flow: no numbered step markup anywhere in the pane.
      noSteps: !document.querySelector("#view .stepnum, #view .step"),
      offersFallback: text.includes("Can't use OAuth"),
      // The move itself: its own tab, FIRST in the bar, under the new key.
      agentsTabFirst: tabs[0] === "agents",
      tabOrder: tabs,
      hasAgentsPane: !!document.querySelector("#view .panel.agents .connect"),
      showsTitle: text.includes("Connect an MCP client"),
      noConnectTab: !document.querySelector('#seg button[data-tab="connect"]'),
      // The client shortcut. Exactly one: a card exists only for a client whose
      // link lands the user where they paste, and ChatGPT has no such link.
      clientCards: [...document.querySelectorAll(".client-card .client-name")].map((n) =>
        n.textContent.trim(),
      ),
    };
  }})()`);

  // The Agents pane gets an image of its own, for the same reason Settings does:
  // every UI change gets one, and this one moved panes. Two frames first, so the
  // capture is what was just asserted rather than the pane painted before it.
  const agentsShot = process.env.AGENTS_OUT ?? "/tmp/agents.png";
  await win.webContents.executeJavaScript(
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))`,
  );
  fs.writeFileSync(agentsShot, (await win.webContents.capturePage()).toPNG());

  // …and the same pane with the static-credential fallback EXPANDED. It is the
  // busiest this pane ever gets, and the state whose spacing has to hold: the
  // form must read as the quiet alternative, not the main event.
  await win.webContents.executeJavaScript(`(() => {
    const link = [...document.querySelectorAll(".linkbtn")].find((b) =>
      b.textContent.includes("static credential"),
    );
    link.click();
    return true;
  })()`);
  await waitFor(win, `document.querySelector(".modal-backdrop .modal input.text")`,
    "the static-credential modal and its name field");
  const agentsOpen = await win.webContents.executeJavaScript(`(${() => {
    const modal = document.querySelector(".modal-backdrop .modal");
    return {
      // The form is IN a modal, and nowhere in the pane.
      opensModal: !!modal,
      formInModal: !!modal && modal.innerText.includes("Name this connection"),
      noInlineForm: !document.querySelector("#view").innerText.includes("Name this connection"),
      // The pane behind it is switched off while it is up.
      paneInert: document.querySelector("#view")?.hasAttribute("inert") === true,
      // Focus went into the dialog rather than staying on the trigger.
      focusInModal: !!modal && modal.contains(document.activeElement),
      buttons: [...(modal?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()),
    };
  }})()`);
  const agentsOpenShot = process.env.AGENTS_OPEN_OUT ?? "/tmp/agents-open.png";
  await win.webContents.executeJavaScript(
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))`,
  );
  fs.writeFileSync(agentsOpenShot, (await win.webContents.capturePage()).toPNG());

  // The vault's honest failure state: locked is not empty, and the screen has to
  // say so — the old copy sent people to debug a server that was running fine.
  await win.webContents.executeJavaScript(`window.__domoSelectTab("vault")`);
  await waitFor(win, `document.querySelector("#view .empty")`, "the vault pane to render");
  const vaultLocked = await win.webContents.executeJavaScript(`(${() => {
    const text = document.body.innerText;
    return {
      saysCannotUnlock: text.includes("can't unlock its vault account"),
      doesNotClaimEmpty: !text.includes("has not started yet"),
      explains: text.includes("The account file is present but cannot be opened"),
      // `undecryptable` covers a wrong key AND a damaged file. The copy must not
      // pick one and state it as fact.
      hedgesTheCause: text.includes("Usually that means") && text.includes("damaged"),
      // The copy must NOT promise a recovery that does not exist:
      // `changeCredentials` refuses when the account cannot be read.
      promisesNoFakeRecovery: !text.includes("Signing in again"),
      saysNothingDeleted: text.includes("Nothing has been deleted"),
    };
  }})()`);
  const vaultShot = process.env.VAULT_OUT ?? "/tmp/vault-locked.png";
  await win.webContents.executeJavaScript(
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))`,
  );
  fs.writeFileSync(vaultShot, (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  await waitFor(win, `document.querySelector("#view .panel.agents")`, "the Agents pane to come back");

  // Esc is a courtesy the FORM gets. (The credential state refuses it, but this
  // probe has no minted credential to test that with — `connect:get` is stubbed
  // with `credential: null` — so this covers the safe half only.)
  await win.webContents.executeJavaScript(`(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;
  })()`);
  await waitFor(win, `!document.querySelector(".modal-backdrop")`, "the modal to close on Esc");
  const modalClosed = await win.webContents.executeJavaScript(`(${() => ({
    gone: !document.querySelector(".modal-backdrop"),
    paneLive: document.querySelector("#view")?.hasAttribute("inert") === false,
    focusBackOnTrigger: (document.activeElement?.textContent ?? "").includes("static credential"),
  })})()`);

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
  await waitFor(approvalWin, `document.body.innerText.includes("Probe Agent")`,
    "the approval window to render its view model");
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
    agentsOpen.opensModal &&
    agentsOpen.formInModal &&
    agentsOpen.noInlineForm &&
    agentsOpen.paneInert &&
    agentsOpen.focusInModal &&
    vaultLocked.saysCannotUnlock &&
    vaultLocked.doesNotClaimEmpty &&
    vaultLocked.explains &&
    vaultLocked.hedgesTheCause &&
    vaultLocked.promisesNoFakeRecovery &&
    vaultLocked.saysNothingDeleted &&
    modalClosed.gone &&
    modalClosed.paneLive &&
    modalClosed.focusBackOnTrigger &&
    connect.showsUrl &&
    connect.showsOauth &&
    connect.noSteps &&
    connect.offersFallback &&
    connect.agentsTabFirst &&
    connect.hasAgentsPane &&
    connect.showsTitle &&
    settingsPane.firstGroupIsAccount &&
    settingsPane.noConnectBlock &&
    settingsPane.noConnectText &&
    settingsPane.noSignInWhileSignedIn &&
    connect.clientCards.join(",") === "Claude" &&
    connect.noConnectTab &&
    settings.hasAccountGroup &&
    settings.showsThisMac &&
    settings.noEndpointRow &&
    settings.noAccountUid &&
    settings.noPhonePromise &&
    settings.explainsDisabledProvider &&
    settings.hintDoesNotStutter &&
    settings.disabledChipIsActionable &&
    settings.offersNoRelayKeyField &&
    !settings.bodyLeaksKey &&
    settings.hasInferenceGroup &&
    settings.hasCapabilitiesGroup &&
    settings.fdaSaysNotGranted &&
    settings.fdaNamesMessages &&
    settings.fdaOffersSystemSettings &&
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
      JSON.stringify({ main, settings, settingsPane, chipsShot, connect, agentsShot, agentsOpen, modalClosed, vaultLocked, vaultShot, agentsOpenShot, transientInput, staleSettingsPane, raceDuringRefresh, optimisticMode, settingsShot, approval, reviewerNote, consoleErrors: errors, ok }),
  );
  app.exit(ok ? 0 : 1);
});
