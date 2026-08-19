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
  readAgentPurpose,
  readInference,
  setAgentPurpose,
  setAnthropicApiKey,
  setApprovalMode,
  setInferenceProvider,
} from "../dist/settingsActions.js";
import { loadSettings, saveSettings } from "../dist/settings.js";
import { launchAtLoginState, setLaunchAtLogin } from "../dist/loginItem.js";

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
ipcMain.handle("settings:getRelay", async () => {
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
// A Mac that has NOT granted Full Disk Access — the state the Capabilities
// section exists to explain.
ipcMain.handle("capabilities:get", async () => ({ fullDiskAccess: false }));
// Launch at Login: the REAL rules from loginItem.js over a fake OS bit.
// Packaged-looking at first so the toggle renders live; flipped unsupported
// mid-run to prove the status refresh re-reads it and the note appears.
let launchSupported = true;
const fakeLoginBit = { openAtLogin: false };
const loginItemApi = {
  get: () => ({ openAtLogin: fakeLoginBit.openAtLogin }),
  set: (s) => (fakeLoginBit.openAtLogin = s.openAtLogin),
};
ipcMain.handle("launch:get", async () => launchAtLoginState(launchSupported, loginItemApi));
ipcMain.handle("launch:set", async (_e, on) => setLaunchAtLogin(launchSupported, loginItemApi, on));
// These four are the real handlers, running the real guards against real
// on-disk settings. A signed-in Mac with no Anthropic key: Plow is usable and
// selected, the Anthropic provider is not.
ipcMain.handle("settings:getApiKey", async () => loadSettings(probeHome).anthropicApiKey ?? "");
ipcMain.handle("settings:setApiKey", async (_e, key) => setAnthropicApiKey(probeHome, key));
ipcMain.handle("settings:getInference", async () => readInference(probeHome));
// The purpose statement, through the real setter — the one path that may write
// it. Nothing an agent can reach registers a handler on either channel.
ipcMain.handle("settings:getAgentPurpose", async () => readAgentPurpose(probeHome));
ipcMain.handle("settings:setAgentPurpose", async (_e, purpose) => setAgentPurpose(probeHome, purpose));
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
ipcMain.handle("vault:items", async () => ({ locked: true, reason: "undecryptable" }));
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

/**
 * Capture the window to a PNG, after two frames have actually landed.
 *
 * The wait is the point: `capturePage()` will happily hand back the pane that
 * was painted BEFORE the click we just asserted on, and an image of the wrong
 * state is worse than no image — it is evidence for something that did not
 * happen. `waitFor` cannot stand in for it; a poll sees state, not paint.
 */
async function captureAfterPaint(win, outputPath) {
  await win.webContents.executeJavaScript(
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))`,
  );
  fs.writeFileSync(outputPath, (await win.webContents.capturePage()).toPNG());
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
  await waitFor(win, `document.querySelector(".panel.settings")`, "the Settings pane");
  const settings = await win.webContents.executeJavaScript(`(${() => {
    return {
      hasAccountGroup: document.body.innerText.includes("Plow Account"),
      // The account group is about this Mac now, not the wire. The endpoint is
      // the Agents tab's job (where it can be copied) and the UID was noise.
      showsThisMac: document.querySelector("#view").innerText.includes("This Mac"),
      noEndpointRow: !document.querySelector("#view").innerText.includes("Agent endpoint"),
      noAccountUid: !document.querySelector("#view").innerText.includes("u_probe"),
      noPhonePromise: !document.querySelector("#view").innerText.includes("phone number"),
      offersNoRelayKeyField: !document.body.innerText.includes("Connect key"),
      bodyLeaksKey: /plow_sk|BEGIN|secret/i.test(document.body.innerText),
      // ---- The AI Reviewer section is GONE from this pane.
      //
      // Not a rename and not a fold into another group: this pane no longer
      // offers a way to point the reviewer anywhere, and no way to hand it a
      // credential of the owner's own. Every check below is the negative of one
      // that used to assert the section was here.
      noInferenceGroup: !document.body.innerText.includes("AI Reviewer"),
      noProviderChips: document.querySelectorAll(".panel.settings .chips").length === 0,
      noReviewerNote: !document.querySelector(".panel.settings .reviewer-note"),
      noKeyField: !document.querySelector(".settings .keyfield"),
      // The field carried the only password input on the pane, so its absence
      // is checkable without knowing what it was called.
      noPasswordField: ![...document.querySelectorAll(".panel.settings input")].some(
        (i) => i.type === "password",
      ),
      noSeparateKeyGroup: ![...document.querySelectorAll(".settings .item > .group-title")].some(
        (t) => t.textContent.trim() === "Anthropic API Key",
      ),
      // Nothing is left pointing at a provider or the model it runs — not a
      // label, not a status line, not a stray mention in prose.
      saysNothingAboutAnthropic: !/anthropic/i.test(document.querySelector("#view").innerText),
      namesNoReviewerModel: !document.body.innerText.includes("anthropic/claude-sonnet-4-6"),
      // The mode chips and the suggestions checkbox both live in Agents now, so
      // neither the controls nor a pointer to them belongs here.
      noApprovalModeGroup: !document.body.innerText.includes("Approval Mode"),
      noModeChipsHere: ![...document.querySelectorAll(".chip")].some((c) =>
        ["Ask me every time", "AI Reviewer decides", "Approve everything", "Deny everything"]
          .includes(c.textContent.trim()),
      ),
      noSuggestionsCheckbox: !document.body.innerText.includes(
        "Let the reviewer suggest an answer when an approval window opens",
      ),
      noPointerToAgentsTab: !document.body.innerText.includes(
        "Whether the reviewer decides on its own is set in the Agents tab",
      ),
      // The word is gone from this pane's copy entirely.
      saysNothingAdversarial: !/adversarial/i.test(document.querySelector("#view").innerText),
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
        (b) => b.textContent.trim() === "Open System Settings…",
      ),
      // The marks split by meaning: the macOS "…" on the one hand-off the user
      // must finish over there (System Settings), the external-link ↗ on the
      // buttons whose click just happens in the browser (Discord, Livestream)
      // — and never both on one button.
      supportMarks: (() => {
        const btns = [...document.querySelectorAll(".support-row .btn")];
        const arrowed = btns.filter((b) => b.querySelector(".ext-arrow"));
        const handoffs = btns.filter((b) => b.textContent.trim().endsWith("…"));
        return btns.length === 3 && arrowed.length === 2 && handoffs.length === 1 &&
          !handoffs[0].querySelector(".ext-arrow");
      })(),
      // Launch at Login, in Capabilities: on this packaged-looking probe the
      // toggle is live and unchecked, and the from-source note is hidden
      // (innerText omits hidden nodes).
      launchTitle: document.body.innerText.includes("Launch at Login"),
      launchToggleLive: (() => {
        const box = [...document.querySelectorAll(".settings input")].find(
          (i) => i.type === "checkbox" &&
            (i.closest("label")?.textContent ?? "").includes("Open Plow Latch when you log in"),
        );
        return !!box && !box.disabled && !box.checked;
      })(),
      launchNoteHidden: !document.body.innerText.includes("from-source run"),
    };
  }})()`);

  // Settings changed with first-run login, and every UI change gets an image.
  const settingsShot = process.env.SETTINGS_OUT ?? "/tmp/settings-account.png";
  await captureAfterPaint(win, settingsShot);

  // The Mac that was already pointed at its own Anthropic key when the section
  // went away. Its stored settings are untouched — the reviewer still runs on
  // that provider, and `settingsActions`/`reviewPolicy` still honour it — but
  // this pane must not show a trace of it, half a control least of all.
  saveSettings(probeHome, {
    ...loadSettings(probeHome),
    relayCredential: "plow_sk_probe_credential",
    anthropicApiKey: "sk-ant-a-real-committed-key",
    inferenceProvider: "anthropic",
    approvalMode: "adversarial",
  });
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("settings")`);
  await waitFor(win, `document.querySelector(".panel.settings")`, "Settings to remount on the stored-key home");
  const strandedProvider = await win.webContents.executeJavaScript(`(${() => {
    const pane = document.querySelector("#view");
    return {
      // No field, so no way for the stored key to be read off the screen…
      noKeyField: !pane.querySelector(".keyfield"),
      noPasswordField: ![...pane.querySelectorAll("input")].some((i) => i.type === "password"),
      // …and the value itself is nowhere in the pane, in any node.
      keyNotInDom: !pane.innerHTML.includes("sk-ant-a-real-committed-key"),
      // …and nothing names the provider it is stored against.
      saysNothingAboutAnthropic: !/anthropic/i.test(pane.innerText),
      noInferenceGroup: !pane.innerText.includes("AI Reviewer"),
    };
  }})()`);
  const strandedSettings = loadSettings(probeHome);
  const strandedOnDisk = {
    ...strandedProvider,
    // Rendering the pane is not a migration: what was on disk is still on disk.
    keyStillStored: strandedSettings.anthropicApiKey === "sk-ant-a-real-committed-key",
    providerStillStored: strandedSettings.inferenceProvider === "anthropic",
    modeStillStored: strandedSettings.approvalMode === "adversarial",
  };

  // An open Settings pane must re-read when main says the account changed —
  // otherwise signing back in leaves the pane describing yesterday's account
  // until someone switches tabs.
  //
  // The observable used to be the reviewer note, which this pane no longer has.
  // The account group is the honest one left: it is what a status change is
  // about, and it says in words whether this Mac is signed in.
  saveSettings(probeHome, {
    ...loadSettings(probeHome),
    relayCredential: "",
    anthropicApiKey: "",
    inferenceProvider: "plow",
  });
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("settings")`);
  await waitFor(
    win,
    `document.body.innerText.includes("Not signed in")`,
    "the account group to say this Mac is signed out",
  );
  const warnedWhileSignedOut = await win.webContents.executeJavaScript(
    `document.body.innerText.includes("Not signed in")`,
  );
  saveSettings(probeHome, { ...loadSettings(probeHome), relayCredential: "plow_sk_now_signed_in" });
  // The same refresh re-reads Launch at Login: the probe goes from-source here,
  // and the pane must follow — toggle dead, note visible.
  launchSupported = false;
  win.webContents.send("status:changed");
  await waitFor(
    win,
    `!document.body.innerText.includes("Not signed in")`,
    "the open Settings pane to re-read the account and drop the signed-out line",
  );
  await waitFor(win, `document.body.innerText.includes("from-source run")`,
    "the Launch at Login row to follow the refresh into its unsupported state");
  const staleSettingsPane = {
    warnedWhileSignedOut,
    warningGoneAfterStatusChanged: await win.webContents.executeJavaScript(
      `!document.body.innerText.includes("Not signed in")`,
    ),
    launchUnsupportedFollowed: await win.webContents.executeJavaScript(`(() => {
      const box = [...document.querySelectorAll(".settings input")].find(
        (i) => i.type === "checkbox" &&
          (i.closest("label")?.textContent ?? "").includes("Open Plow Latch when you log in"),
      );
      return !!box && box.disabled && document.body.innerText.includes("from-source run");
    })()`),
  };

  // What used to sit here: the half-typed-key race — typing into the API-key
  // field while a status-driven refresh was parked mid-flight, proving the
  // refresh could not replace the node under the typist. The field is gone with
  // the section, and Settings has no editable control left for it to race, so
  // the check goes with it rather than being retargeted at a field that has no
  // such hazard. The property it protected — refresh updates display nodes,
  // never rebuilds the pane — is what `staleSettingsPane` above still shows.

  // REPRO (c): the renderer must show what main STORED, not what it asked for.
  saveSettings(probeHome, {
    ...loadSettings(probeHome),
    relayCredential: "plow_sk_probe_credential",
    anthropicApiKey: "",
    inferenceProvider: "plow",
    approvalMode: "ask",
  });
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  await waitFor(win, `[...document.querySelectorAll(".chip")].some((c) => c.textContent.trim() === "AI Reviewer decides" && !c.classList.contains("disabled"))`,
    "the AI Reviewer chip to render enabled");
  // The credential goes AFTER the pane rendered, with no notification — so the
  // chip is still enabled and the renderer still believes it can select this.
  saveSettings(probeHome, { ...loadSettings(probeHome), relayCredential: "" });
  await win.webContents.executeJavaScript(`(() => {
    const chip = [...document.querySelectorAll(".chip")].find((c) => c.textContent.trim() === "AI Reviewer decides");
    chip.click();
    return true;
  })()`);
  await waitFor(win, `[...document.querySelectorAll(".chip")].some((c) => c.textContent.trim() === "AI Reviewer decides" && c.classList.contains("active"))`,
    "the pane to follow main's acceptance of the reviewer mode");
  const optimisticMode = {
    // Losing the credential no longer rewrites the mode behind the user.
    storedIsAdversarial: loadSettings(probeHome).approvalMode === "adversarial",
    // What the pane claims, against what main actually stored.
    chipAgrees: await win.webContents.executeJavaScript(`(() => {
      const chip = [...document.querySelectorAll(".chip")].find((c) => c.textContent.trim() === "AI Reviewer decides");
      return !!chip && chip.classList.contains("active");
    })()`),
    // …and the purpose field follows the MODE, not the credential. The owner
    // picked "AI Reviewer decides" and that choice stands, so what the reviewer
    // will read stays on offer — there is nothing to write it into yet, which
    // the note beside it says.
    purposeFieldStillOffered: await win.webContents.executeJavaScript(
      `!!document.querySelector("#view textarea.text")?.checkVisibility()`,
    ),
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
      // The card is an action, not a brand tile: plain-weight label, ↗ mark.
      clientCardArrow: !!document.querySelector(".client-card .ext-arrow"),
      clientNameNotBold: getComputedStyle(
        document.querySelector(".client-card .client-name"),
      ).fontWeight === "400",
    };
  }})()`);

  // The Agents pane gets an image of its own, for the same reason Settings does:
  // every UI change gets one, and this one moved panes.
  const agentsShot = process.env.AGENTS_OUT ?? "/tmp/agents.png";
  await captureAfterPaint(win, agentsShot);

  // The Approvals card: the modes, and the owner's purpose statement. Two
  // states, because the card has two — the field under the reviewer chip, and
  // one honest line in its place under every other one.
  saveSettings(probeHome, {
    ...loadSettings(probeHome),
    relayCredential: "plow_sk_probe_credential",
    approvalMode: "adversarial",
    inferenceProvider: "plow",
    agentPurpose: "Groceries and calendar only.",
  });
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  await waitFor(win, `[...document.querySelectorAll(".chip")].some((c) => c.textContent.trim() === "AI Reviewer decides" && c.classList.contains("active"))`,
    "the Approvals card in its reviewer state");
  const approvalsReviewer = await win.webContents.executeJavaScript(`(${() => {
    const pane = document.querySelector("#view");
    const field = pane.querySelector("textarea.text");
    return {
      chipLabels: [...pane.querySelectorAll(".chips .chip")].map((c) => c.textContent.trim()),
      inAgentsPane: !!pane.querySelector(".panel.agents"),
      // The stored text, in the field, and the two things said beside it.
      showsStoredPurpose: !!field && field.checkVisibility() && field.value === "Groceries and calendar only.",
      labelled: pane.innerText.includes("What are agents for?"),
      saysItOnlyNarrows: pane.innerText.includes("It can only narrow what gets approved"),
      saysItMayApprove: pane.innerText.includes("Requests that fit may be approved without asking you."),
      // The card is context, not enforcement: no capability list here, and the
      // word this rename retired is nowhere on screen.
      noAdversarialWord: !/adversarial/i.test(pane.innerText),
      noHintLineTakingItsPlace: !pane.innerText.includes("Any request a rule doesn't already cover opens an approval window"),
      // The suggestions checkbox came here from Settings when that pane's
      // reviewer section went away. In this mode nobody is being asked, so
      // there is no suggestion to show: on screen, and dead.
      hasSuggestionsCheckbox: pane.innerText.includes(
        "Let the reviewer suggest an answer when an approval window opens",
      ),
      suggestionsDeadInReviewerMode: (() => {
        const box = [...pane.querySelectorAll("input")].find(
          (i) => i.type === "checkbox" &&
            (i.closest("label")?.textContent ?? "").includes("Let the reviewer suggest"),
        );
        return !!box && box.disabled && !!box.closest("label")?.classList.contains("disabled");
      })(),
    };
  }})()`);
  const scrollToApprovals = () => win.webContents.executeJavaScript(`(() => {
    const title = [...document.querySelectorAll(".agents .item > .group-title")]
      .find((t) => t.textContent.trim() === "Approvals");
    title?.scrollIntoView({ block: "start" });
    return true;
  })()`);
  await scrollToApprovals();
  const approvalsShot = process.env.APPROVALS_OUT ?? "/tmp/agents-approvals.png";
  await win.webContents.executeJavaScript(
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))`,
  );
  fs.writeFileSync(approvalsShot, (await win.webContents.capturePage()).toPNG());

  // The field commits on `change`, like the API key, and what goes back on
  // screen is what the setter stored.
  await win.webContents.executeJavaScript(`(() => {
    const field = document.querySelector("#view textarea.text");
    field.value = "  Only household errands.  ";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await waitForNode(() => loadSettings(probeHome).agentPurpose === "Only household errands.",
    "the purpose to reach settings.json through the IPC pair");
  // The field redraws off what main stored, one refresh after the write — the
  // same round-trip the mode chips make below. Reading it the instant the file
  // lands is a race, and on a slow runner the read wins.
  await waitFor(win, `document.querySelector("#view textarea.text").value === "Only household errands."`,
    "the purpose field to show what was stored");
  const purposeRoundTrip = {
    stored: loadSettings(probeHome).agentPurpose === "Only household errands.",
    fieldShowsWhatWasStored: await win.webContents.executeJavaScript(
      `document.querySelector("#view textarea.text").value === "Only household errands."`,
    ),
  };

  // Ask mode: no field at all, and the line that replaces it.
  await win.webContents.executeJavaScript(`(() => {
    const chip = [...document.querySelectorAll(".chip")].find((c) => c.textContent.trim() === "Ask me every time");
    chip.click();
    return true;
  })()`);
  await waitForNode(() => loadSettings(probeHome).approvalMode === "ask",
    "Ask mode to be stored");
  // …and the card redraws off what main stored, one round-trip after the click.
  await waitFor(win, `[...document.querySelectorAll(".chip")].some((c) => c.textContent.trim() === "Ask me every time" && c.classList.contains("active"))`,
    "the Approvals card to follow the stored mode");
  const approvalsAsk = await win.webContents.executeJavaScript(`(${() => {
    const pane = document.querySelector("#view");
    const field = pane.querySelector("textarea.text");
    return {
      fieldGone: !field || !field.checkVisibility(),
      // The label goes with it: nothing about the purpose is on screen in a
      // mode whose reviewer never reads it…
      purposeTextGone: !pane.innerText.includes("What are agents for?"),
      // …and the card still says what this mode does.
      showsHint: pane.innerText.includes("Any request a rule doesn't already cover opens an approval window"),
      // The hint used to send people to Settings for the suggestions toggle.
      // The toggle is in this card now, so the sentence points at it and not at
      // a pane that no longer has one.
      pointsAtTheCheckboxBelow: pane.innerText.includes("turn that on below"),
      noPointerToSettings: !pane.innerText.includes("turn that on in Settings"),
      // Ask mode with a credentialled reviewer: the one state where a
      // suggestion can actually be shown, so the box is live.
      suggestionsLive: (() => {
        const box = [...pane.querySelectorAll("input")].find(
          (i) => i.type === "checkbox" &&
            (i.closest("label")?.textContent ?? "").includes("Let the reviewer suggest"),
        );
        return !!box && !box.disabled && box.checked;
      })(),
    };
  }})()`);
  await scrollToApprovals();
  const approvalsShotAsk = process.env.APPROVALS_ASK_OUT ?? "/tmp/agents-approvals-ask.png";
  await win.webContents.executeJavaScript(
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))`,
  );
  fs.writeFileSync(approvalsShotAsk, (await win.webContents.capturePage()).toPNG());

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
  await captureAfterPaint(win, agentsOpenShot);

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
      // The copy must NOT promise a recovery that does not exist: an account
      // that cannot be decrypted cannot be signed in with either.
      promisesNoFakeRecovery: !text.includes("Signing in again"),
      saysNothingDeleted: text.includes("Nothing has been deleted"),
    };
  }})()`);
  const vaultShot = process.env.VAULT_OUT ?? "/tmp/vault-locked.png";
  await captureAfterPaint(win, vaultShot);
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
    connect.clientCards.join(",") === "Open Claude" &&
    connect.clientCardArrow &&
    connect.clientNameNotBold &&
    connect.noConnectTab &&
    settings.hasAccountGroup &&
    settings.showsThisMac &&
    settings.noEndpointRow &&
    settings.noAccountUid &&
    settings.noPhonePromise &&
    settings.offersNoRelayKeyField &&
    !settings.bodyLeaksKey &&
    settings.noInferenceGroup &&
    settings.noProviderChips &&
    settings.noReviewerNote &&
    settings.noKeyField &&
    settings.noPasswordField &&
    settings.noSeparateKeyGroup &&
    settings.saysNothingAboutAnthropic &&
    settings.namesNoReviewerModel &&
    settings.hasCapabilitiesGroup &&
    settings.fdaSaysNotGranted &&
    settings.fdaNamesMessages &&
    settings.fdaOffersSystemSettings &&
    settings.supportMarks &&
    settings.launchTitle &&
    settings.launchToggleLive &&
    settings.launchNoteHidden &&
    staleSettingsPane.launchUnsupportedFollowed &&
    strandedOnDisk.noKeyField &&
    strandedOnDisk.noPasswordField &&
    strandedOnDisk.keyNotInDom &&
    strandedOnDisk.saysNothingAboutAnthropic &&
    strandedOnDisk.noInferenceGroup &&
    strandedOnDisk.keyStillStored &&
    strandedOnDisk.providerStillStored &&
    strandedOnDisk.modeStillStored &&
    staleSettingsPane.warnedWhileSignedOut &&
    staleSettingsPane.warningGoneAfterStatusChanged &&
    optimisticMode.storedIsAdversarial &&
    optimisticMode.chipAgrees &&
    optimisticMode.purposeFieldStillOffered &&
    approvalsReviewer.chipLabels.join(",") ===
      "Ask me every time,AI Reviewer decides,Approve everything,Deny everything" &&
    approvalsReviewer.inAgentsPane &&
    approvalsReviewer.showsStoredPurpose &&
    approvalsReviewer.labelled &&
    approvalsReviewer.saysItOnlyNarrows &&
    approvalsReviewer.saysItMayApprove &&
    approvalsReviewer.noAdversarialWord &&
    approvalsReviewer.noHintLineTakingItsPlace &&
    approvalsReviewer.hasSuggestionsCheckbox &&
    approvalsReviewer.suggestionsDeadInReviewerMode &&
    purposeRoundTrip.stored &&
    purposeRoundTrip.fieldShowsWhatWasStored &&
    approvalsAsk.fieldGone &&
    approvalsAsk.purposeTextGone &&
    approvalsAsk.showsHint &&
    approvalsAsk.pointsAtTheCheckboxBelow &&
    approvalsAsk.noPointerToSettings &&
    approvalsAsk.suggestionsLive &&
    settings.noApprovalModeGroup &&
    settings.noModeChipsHere &&
    settings.noSuggestionsCheckbox &&
    settings.noPointerToAgentsTab &&
    settings.saysNothingAdversarial &&
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
      JSON.stringify({ main, settings, strandedOnDisk, settingsPane, connect, agentsShot, approvalsReviewer, approvalsShot, purposeRoundTrip, approvalsAsk, approvalsShotAsk, agentsOpen, modalClosed, vaultLocked, vaultShot, agentsOpenShot, staleSettingsPane, optimisticMode, settingsShot, approval, reviewerNote, consoleErrors: errors, ok }),
  );
  app.exit(ok ? 0 : 1);
}).catch((err) => {
  // Without this, a throw in the probe above — a `waitFor` that times out
  // because the behavior it waits for no longer exists — leaves Electron
  // running with no window and nothing to end it, and CI sits on a live
  // runner until the job's own timeout hours later. A failed check has to
  // read as a failed check.
  console.error("PROBE-FAILED:", err?.stack ?? err);
  app.exit(1);
});
