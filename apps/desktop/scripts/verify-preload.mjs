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
  setApprovalMode,
} from "../dist/settingsActions.js";
import { loadSettings, saveSettings } from "../dist/settings.js";
import { launchAtLoginState, setLaunchAtLogin } from "../dist/loginItem.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");

// A throwaway home for the round-trip checks: signed in to Plow, so the
// reviewer can run.
const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), "domo-probe-"));
saveSettings(probeHome, {
  ...loadSettings(probeHome),
  relayCredential: "plow_sk_probe_credential",
  accountUid: "u_probe",
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
ipcMain.handle("settings:getInference", async () => readInference(probeHome));
// The purpose statement, through the real setter — the one path that may write
// it. Nothing an agent can reach registers a handler on either channel.
ipcMain.handle("settings:getAgentPurpose", async () => readAgentPurpose(probeHome));
ipcMain.handle("settings:setAgentPurpose", async (_e, purpose) => setAgentPurpose(probeHome, purpose));
const cloudChat = { uid: "chat_probe", label: "+1 (415) 555-0142 · Alex, Sam" };
const cloudAgent = {
  agentId: "cag_probe",
  name: "Household helper",
  chatUid: cloudChat.uid,
  chatLabel: cloudChat.label,
  provider: "anthropic",
  status: "active",
  failureReason: null,
  createdAt: "2026-08-24T18:00:00.000Z",
};
let cloudProbe = {
  cloudAgents: [cloudAgent],
  cloudAgentsError: null,
  cloudActionError: null,
  cloudChats: [cloudChat],
  cloudChatsForbidden: false,
  cloudChatsLoaded: true,
  cloudSendTo: "+1 (415) 555-0199",
  cloudEnabled: true,
  cloudAgentSettings: {
    cag_probe: { relay: true, inference: false, adversarialReview: false },
  },
  cloudSaving: null,
  cloudSaveError: null,
};
const cloudCalls = { create: [], delete: [], retry: [], apply: [] };
let cloudApplyFails = false;

// Connect state also carries the cloud-agent display state. It contains no
// credential, session id or worker URL.
ipcMain.handle("connect:get", async () => ({
  mcpUrl: "https://api.plow.co/v1/relay/devices/u_probe/mcp",
  accountUid: "u_probe",
  connected: true,
  hasCredential: true,
  busy: false,
  message: "",
  credential: null,
  ...cloudProbe,
}));
ipcMain.handle("cloud:create", async (_e, chatUid, name) => cloudCalls.create.push({ chatUid, name }));
ipcMain.handle("cloud:delete", async (_e, agentId) => cloudCalls.delete.push(agentId));
ipcMain.handle("cloud:retry", async (_e, agentId) => cloudCalls.retry.push(agentId));
ipcMain.handle("cloud:apply", async (_e, agentId, settings) => {
  cloudCalls.apply.push({ agentId, settings });
  if (cloudApplyFails) {
    const previous = cloudProbe.cloudAgentSettings[agentId];
    cloudProbe = {
      ...cloudProbe,
      cloudAgentSettings: {
        ...cloudProbe.cloudAgentSettings,
        [agentId]: { ...previous, adversarialReview: settings.adversarialReview },
      },
      cloudSaving: null,
      cloudSaveError: { agentId, message: "Plow could not update this agent." },
    };
    return;
  }
  if (settings.relay === null && settings.inference === null) {
    const previous = cloudProbe.cloudAgentSettings[agentId];
    cloudProbe = {
      ...cloudProbe,
      cloudAgentSettings: {
        ...cloudProbe.cloudAgentSettings,
        [agentId]: { ...previous, adversarialReview: settings.adversarialReview },
      },
      cloudSaving: null,
      cloudSaveError: null,
    };
    return;
  }
  cloudProbe = { ...cloudProbe, cloudSaving: agentId, cloudSaveError: null };
});
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
// Switchable, because the unsaved-edits checks further down need a vault with
// something in it — the locked reply above has no list and no forms.
let vaultItemsReply = { locked: true, reason: "undecryptable" };
ipcMain.handle("vault:items", async () => vaultItemsReply);
ipcMain.handle("vault:item", async () => ({
  id: "itm1",
  type: "login",
  name: "Notion",
  revision: 1,
  fields: { username: "owner@probe" },
  secrets: ["password"],
  urls: ["https://notion.so"],
  notes: "",
}));
// Holdable, so a check can look at the pane WHILE a vault call is in flight.
// A deferred promise, not a delay: the check runs when the call is provably in
// flight and releases it explicitly, so no amount of scheduling jitter can let
// the reveal finish first.
let holdReveal = false;
let releaseReveal = null;
ipcMain.handle("vault:reveal", async () => {
  if (holdReveal) await new Promise((r) => { releaseReveal = r; });
  return "revealed-secret";
});
// Holdable like the reveal, so a check can act while a SAVE is in flight — the
// transaction that ends by replacing the pane, which a held reveal never does.
let holdSave = false;
let releaseSave = null;
ipcMain.handle("vault:saveItem", async () => {
  if (holdSave) await new Promise((r) => { releaseSave = r; });
  return { id: "itm1" };
});
ipcMain.handle("vault:deleteItem", async () => true);
ipcMain.handle("settings:getApprovalMode", async () => "ask");
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
      // Three checks, not ten. The group, the credential field, and the control
      // that moved: everything else that used to be asserted here — the chips,
      // the note, the model string, the pointer sentence — cannot survive the
      // group's absence, and spelling each one out fenced in the markup of a
      // section that no longer exists.
      noReviewerGroup: ![...document.querySelectorAll(".panel.settings .group-title")].some(
        (t) => t.textContent.trim() === "AI Reviewer",
      ),
      noPasswordField: !document.querySelector('.panel.settings input[type="password"]'),
      noSuggestionsCheckbox: !document.body.innerText.includes("Let the reviewer suggest"),
      // The mode chips left this pane for Agents before this change did, so
      // these are not the reviewer group's to prove.
      noApprovalModeGroup: !document.body.innerText.includes("Approval Mode"),
      noModeChipsHere: ![...document.querySelectorAll(".chip")].some((c) =>
        ["Ask me every time", "AI Reviewer decides", "Approve everything", "Deny everything"]
          .includes(c.textContent.trim()),
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

  // The Mac that once pasted its own Anthropic key. Its settings.json still
  // holds the retired fields until something reads them; loading is what takes
  // them off disk, and the pane must show no trace of them either way.
  const strandedFile = path.join(probeHome, "app/settings.json");
  fs.writeFileSync(
    strandedFile,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(strandedFile, "utf8")),
      relayCredential: "plow_sk_probe_credential",
      approvalMode: "adversarial",
      anthropicApiKey: "sk-ant-a-real-committed-key",
      inferenceProvider: "anthropic",
    }),
  );
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("settings")`);
  await waitFor(win, `document.querySelector(".panel.settings")`, "Settings to remount on the stored-key home");
  // One thing to prove about the pane: the stored key is in no node of it,
  // visible or not. That the section is gone is the check above, not this one.
  const keyNotInDom = await win.webContents.executeJavaScript(
    `!document.querySelector("#view").innerHTML.includes("sk-ant-a-real-committed-key")`,
  );
  // …and rendering it was a read, so the retired fields are off disk for good.
  const strandedOnDisk = {
    keyNotInDom,
    scrubbedFromDisk: !fs.readFileSync(strandedFile, "utf8").includes("sk-ant-a-real-committed-key"),
    reviewerStillUsable: loadSettings(probeHome).relayCredential === "plow_sk_probe_credential",
    modeStillStored: loadSettings(probeHome).approvalMode === "adversarial",
  };

  // An open Settings pane must re-read when main says the account changed —
  // otherwise signing back in leaves the pane describing yesterday's account
  // until someone switches tabs.
  //
  // The observable used to be the reviewer note, which this pane no longer has.
  // The account group is the honest one left: it is what a status change is
  // about, and it says in words whether this Mac is signed in.
  saveSettings(probeHome, { ...loadSettings(probeHome), relayCredential: "" });
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

  const cloudRoster = await win.webContents.executeJavaScript(`(${() => {
    const group = [...document.querySelectorAll("#view .panel.agents > .item")]
      .find((item) => item.querySelector(":scope > .group-title")?.textContent.trim() === "Cloud agents");
    const row = group?.querySelector(".cloud-agent-row");
    return {
      aboveConnect: group?.nextElementSibling?.querySelector(":scope > .group-title")?.textContent.trim() === "Connect an MCP client",
      showsName: row?.textContent.includes("Household helper"),
      showsChat: row?.textContent.includes("+1 (415) 555-0142 · Alex, Sam"),
      showsProvider: row?.textContent.includes("Anthropic"),
      status: row?.querySelector(".badge")?.textContent.trim(),
      hasActions: [...(row?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()).join(",") === "Settings,Remove",
      noCredentialIdentity: !group?.textContent.includes("session") && !group?.textContent.includes("worker"),
    };
  }})()`);

  // The warning is specific to the first agent on a chat. Remove the fixture
  // row, remount the pane, and open the picker through the exposed control.
  cloudProbe = { ...cloudProbe, cloudAgents: [] };
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  await waitFor(win, `document.querySelector(".cloud-toolbar button")`, "the cloud-agent setup action");
  await win.webContents.executeJavaScript(`document.querySelector(".cloud-toolbar button").click()`);
  await waitFor(win, `document.querySelector(".cloud-modal .cloud-warning")`, "the first-agent warning");
  const cloudPicker = await win.webContents.executeJavaScript(`(${() => {
    const modal = document.querySelector(".cloud-modal");
    return {
      listsEveryChat: [...modal.querySelectorAll("option")].map((o) => o.textContent.trim()).join(",") === "+1 (415) 555-0142 · Alex, Sam,New chat…",
      warnsIrreversible: modal.textContent.includes("Removing the agent later will not restore them"),
      labelsOptionalName: modal.textContent.includes("Name (optional)"),
    };
  }})()`);
  const cloudModalGuard = await win.webContents.executeJavaScript(`(${async () => {
    const visibleSelect = document.querySelector(".cloud-modal select");
    const trigger = document.querySelector(".cloud-toolbar button");
    const selectPrototype = HTMLSelectElement.prototype;
    const addEventListener = selectPrototype.addEventListener;
    let blockedSelect = null;
    selectPrototype.addEventListener = function (type, ...args) {
      if (type === "change" && this !== visibleSelect) blockedSelect = this;
      return addEventListener.call(this, type, ...args);
    };
    try {
      trigger.click();
    } finally {
      selectPrototype.addEventListener = addEventListener;
    }
    if (!blockedSelect) return { ignored: false, keptOriginal: false };
    let error = null;
    const onError = (event) => {
      error = event.error ?? new Error(event.message);
      event.preventDefault();
    };
    window.addEventListener("error", onError, { once: true });
    blockedSelect.value = "__new_chat__";
    blockedSelect.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve));
    window.removeEventListener("error", onError);
    return {
      ignored: error === null,
      keptOriginal: document.querySelector(".cloud-modal select") === visibleSelect,
    };
  }})()`);
  await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector(".cloud-modal select");
    select.value = "__new_chat__";
    select.dispatchEvent(new Event("change"));
  })()`);
  await waitFor(win, `document.querySelector(".cloud-modal .cloud-route")`, "the new-chat explainer");
  const cloudNewChat = await win.webContents.executeJavaScript(`(${() => {
    const modal = document.querySelector(".cloud-modal");
    return {
      twoRoutes: [...modal.querySelectorAll(".cloud-route-title")].map((n) => n.textContent.trim()).join(",") ===
        "Verify a new Plow number,Start a group thread",
      serverNumber: modal.textContent.includes("Number to text: +1 (415) 555-0199"),
      groupRoute: modal.textContent.includes("The chat appears here once someone speaks"),
    };
  }})()`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll(".cloud-modal button")].find((b) => b.textContent.trim() === "Back").click()`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll(".cloud-modal button")].find((b) => b.textContent.trim() === "Cancel").click()`);

  cloudProbe = { ...cloudProbe, cloudAgents: [cloudAgent] };
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  await waitFor(win, `document.querySelector(".cloud-agent-row button")`, "the cloud-agent row actions");
  await win.webContents.executeJavaScript(`[...document.querySelectorAll(".cloud-agent-row button")].find((b) => b.textContent.trim() === "Settings").click()`);
  await waitFor(win, `document.querySelector(".cloud-modal .cloud-setting")`, "the cloud-agent settings panel");
  const cloudSettingsPanel = await win.webContents.executeJavaScript(`(${() => {
    const modal = document.querySelector(".cloud-modal");
    const checked = Object.fromEntries([...modal.querySelectorAll(".cloud-setting")].map((label) => [
      label.querySelector(".cloud-setting-title")?.textContent.trim(),
      label.querySelector("input")?.checked,
    ]));
    return {
      threeControls: Object.keys(checked).join(",") === "Relay access,May spend inference,Adversarial review",
      storedValues: checked["Relay access"] === true &&
        checked["May spend inference"] === false && checked["Adversarial review"] === false,
      restartScoped: modal.querySelector(".cloud-server-settings")?.textContent.includes("Your agent will restart briefly") &&
        !modal.querySelector(".cloud-local-settings")?.textContent.includes("restart briefly"),
      localWithoutRestart: modal.querySelector(".cloud-local-settings")?.textContent.includes("without restarting your agent"),
      appliesTogether: [...modal.querySelectorAll("button")].some((button) => button.textContent.trim() === "Apply changes"),
    };
  }})()`);
  await win.webContents.executeJavaScript(`(() => {
    const checks = [...document.querySelectorAll(".cloud-modal input[type=checkbox]")];
    checks.forEach((check) => check.click());
    [...document.querySelectorAll(".cloud-modal button")].find((b) => b.textContent.trim() === "Apply changes").click();
  })()`);
  await waitFor(win, `[...document.querySelectorAll(".cloud-modal button")].some((b) => b.textContent.trim() === "Updating agent…")`,
    "the cloud-agent updating state");
  const cloudUpdating = await win.webContents.executeJavaScript(`(${() => ({
    exactCopy: [...document.querySelectorAll(".cloud-modal button")]
      .some((button) => button.textContent.trim() === "Updating agent…"),
    controlsDisabled: [...document.querySelectorAll(".cloud-modal input")].every((input) => input.disabled),
    canClose: [...document.querySelectorAll(".cloud-modal button")]
      .some((button) => button.textContent.trim() === "Cancel" && !button.disabled),
    rowStillListed: document.querySelector(".cloud-agent-row")?.textContent.includes("Household helper"),
  })})()`);
  const applied = cloudCalls.apply[0];
  cloudProbe = {
    ...cloudProbe,
    cloudAgentSettings: {
      ...cloudProbe.cloudAgentSettings,
      cag_probe: { ...applied.settings },
    },
    cloudSaving: null,
  };
  win.webContents.send("connect:changed");
  await waitFor(win, `!document.querySelector(".cloud-modal")`, "the successful cloud-agent settings write");
  const cloudSettings = {
    stableId: applied?.agentId === "cag_probe",
    exactSettings: applied?.settings?.relay === false && applied?.settings?.inference === true &&
      applied?.settings?.adversarialReview === true && Object.keys(applied?.settings ?? {}).length === 3,
  };

  cloudApplyFails = true;
  await win.webContents.executeJavaScript(`[...document.querySelectorAll(".cloud-agent-row button")].find((b) => b.textContent.trim() === "Settings").click()`);
  await waitFor(win, `document.querySelector(".cloud-modal .cloud-setting")`, "the cloud-agent settings panel for a failed save");
  await win.webContents.executeJavaScript(`(() => {
    const checks = [...document.querySelectorAll(".cloud-modal input[type=checkbox]")];
    checks.forEach((check) => check.click());
    [...document.querySelectorAll(".cloud-modal button")].find((b) => b.textContent.trim() === "Apply changes").click();
  })()`);
  await waitFor(win, `document.querySelector(".cloud-modal .cloud-save-error:not([hidden])")`,
    "the failed cloud-agent settings write");
  const cloudSettingsFailure = await win.webContents.executeJavaScript(`(${() => {
    const checks = [...document.querySelectorAll(".cloud-modal input[type=checkbox]")];
    return {
      showsFailure: document.querySelector(".cloud-save-error")?.textContent.includes("Plow could not update this agent"),
      priorServerSettings: checks[0]?.checked === false && checks[1]?.checked === true,
      localSettingApplied: checks[2]?.checked === false,
      controlsEnabled: checks.every((input) => !input.disabled),
      rowStillListed: document.querySelector(".cloud-agent-row")?.textContent.includes("Household helper"),
    };
  }})()`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll(".cloud-modal button")].find((b) => b.textContent.trim() === "Cancel").click()`);
  cloudApplyFails = false;
  cloudProbe = {
    ...cloudProbe,
    cloudAgentSettings: { cag_probe: { adversarialReview: false } },
    cloudSaveError: { agentId: "cag_someone_else", message: "This belongs to another agent." },
  };
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  await waitFor(win, `document.querySelector(".cloud-agent-row button")`, "the unknown-permissions row");
  await win.webContents.executeJavaScript(`[...document.querySelectorAll(".cloud-agent-row button")].find((b) => b.textContent.trim() === "Settings").click()`);
  await waitFor(win, `document.querySelector(".cloud-modal .cloud-unknown-note")`, "the unknown-permissions panel");
  const cloudUnknown = await win.webContents.executeJavaScript(`(${() => {
    const modal = document.querySelector(".cloud-modal");
    const permissions = [...modal.querySelectorAll(".cloud-server-settings input")];
    return {
      bothIndeterminate: permissions.length === 2 && permissions.every((input) => input.indeterminate),
      bothNamedUnknown: [...modal.querySelectorAll(".cloud-setting-unknown:not([hidden])")].length === 2,
      explainsUnknown: modal.querySelector(".cloud-unknown-note")?.textContent.trim() ===
        "Plow doesn't report an agent's current permissions; applying will set them.",
      noOtherAgentError: !modal.textContent.includes("This belongs to another agent"),
      localOnlyAllowed: [...modal.querySelectorAll("button")]
        .some((button) => button.textContent.trim() === "Apply changes" && !button.disabled),
    };
  }})()`);
  const cloudUnknownChoice = await win.webContents.executeJavaScript(`(${() => {
    const modal = document.querySelector(".cloud-modal");
    const permissions = [...modal.querySelectorAll(".cloud-server-settings input")];
    const apply = [...modal.querySelectorAll("button")].find((button) => button.textContent.trim() === "Apply changes");
    permissions[0].click();
    const oneChoiceBlocked = apply.disabled &&
      modal.querySelector(".cloud-choose-note")?.textContent.includes("Choose both permissions");
    permissions[1].click();
    return {
      oneChoiceBlocked,
      bothChoicesAllowed: !apply.disabled,
      noLongerGuesses: permissions.every((input) => !input.indeterminate),
    };
  }})()`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll(".cloud-modal button")].find((b) => b.textContent.trim() === "Cancel").click()`);

  cloudProbe = { ...cloudProbe, cloudSaveError: null };
  win.webContents.send("connect:changed");
  await waitFor(win, `document.querySelector(".cloud-agent-row button")`, "the unknown-permissions row to refresh");
  await win.webContents.executeJavaScript(`[...document.querySelectorAll(".cloud-agent-row button")].find((b) => b.textContent.trim() === "Settings").click()`);
  await waitFor(win, `document.querySelector(".cloud-modal .cloud-unknown-note")`, "the local-only unknown-permissions panel");
  await win.webContents.executeJavaScript(`(() => {
    const modal = document.querySelector(".cloud-modal");
    modal.querySelector(".cloud-local-settings input").click();
    [...modal.querySelectorAll("button")].find((b) => b.textContent.trim() === "Apply changes").click();
  })()`);
  await waitFor(win, `!document.querySelector(".cloud-modal")`, "the local-only unknown-permissions save");
  const localOnly = cloudCalls.apply[2];
  const cloudUnknownLocalOnly = {
    stableId: localOnly?.agentId === "cag_probe",
    untouchedPermissions: localOnly?.settings?.relay === null && localOnly?.settings?.inference === null,
    reviewApplied: localOnly?.settings?.adversarialReview === true,
    noRestart: cloudProbe.cloudSaving === null,
  };

  cloudProbe = {
    ...cloudProbe,
    cloudAgents: [cloudAgent],
    cloudAgentsError: "Couldn't reach Plow.",
    cloudChats: [],
    cloudChatsForbidden: false,
    cloudChatsLoaded: false,
  };
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  await waitFor(win, `document.querySelector(".cloud-error")`, "the failed chat-list banner");
  const cloudChatFailure = await win.webContents.executeJavaScript(`(${() => ({
    showsError: document.querySelector(".cloud-error")?.textContent.includes("Couldn't reach Plow"),
    notEmptyState: !document.querySelector(".cloud-empty"),
    keepsRoster: document.querySelector(".cloud-agent-row")?.textContent.includes("Household helper"),
  })})()`);

  cloudProbe = {
    ...cloudProbe,
    cloudAgentsError: "This Mac isn't allowed to list chats.",
    cloudChatsForbidden: true,
  };
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  await waitFor(win, `document.querySelector(".cloud-error")`, "the 403 chat-list banner");
  const cloudForbidden = await win.webContents.executeJavaScript(`(${() => ({
    ordinaryError: document.querySelector(".cloud-error")?.textContent.includes("This Mac isn't allowed to list chats"),
    noSpecialState: !document.querySelector(".cloud-forbidden") && !document.body.innerText.includes("Re-activate to access chats"),
    keepsRoster: document.querySelector(".cloud-agent-row")?.textContent.includes("Household helper"),
  })})()`);

  cloudProbe = {
    ...cloudProbe,
    cloudAgents: [],
    cloudAgentsError: null,
    cloudChatsForbidden: false,
    cloudChatsLoaded: true,
  };
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  await waitFor(win, `document.querySelector(".cloud-empty")`, "the literal cloud-agent empty state");
  const cloudEmpty = await win.webContents.executeJavaScript(`(${() => ({
    literal: document.querySelector(".cloud-empty")?.textContent.trim() === "No agents.",
    noNumber: !document.querySelector("#view .panel.agents > .item")?.textContent.includes("+1 (415) 555-0199"),
    noExplanation: !document.querySelector(".cloud-empty")?.textContent.includes("chat"),
  })})()`);

  // Restore the roster for the screenshot and the existing Agents-pane probes.
  cloudProbe = {
    ...cloudProbe,
    cloudAgents: [cloudAgent],
    cloudChats: [cloudChat],
    cloudChatsForbidden: false,
    cloudChatsLoaded: true,
  };
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  await waitFor(win, `document.querySelector(".cloud-agent-row")`, "the restored cloud-agent roster");

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
      purposeExampleHasBoundary: field?.placeholder.endsWith(
        "You have no business with anything else on this computer — no files, no other sites.",
      ) ?? false,
      labelled: pane.innerText.includes("What are agents for?"),
      // The purpose is the ERRAND, and an errand widens as readily as it
      // narrows: an owner who writes "Manage my SSH keys" has just made those
      // keys the job. This probe used to pin the opposite claim — that the
      // field "can only narrow what gets approved" — which was both untrue and
      // the wrong direction, so it pins the new contract and the absence of
      // the old promise.
      saysItCanWiden: pane.innerText.includes(
        "it can widen what gets approved as easily as narrow it",
      ),
      noOnlyNarrowsClaim: !pane.innerText.includes("only narrow"),
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
      // …but a purpose written under the reviewer chip is still sent with every
      // suggestion this mode asks for, so the disclosure has to name it in the
      // mode that hides the field. This is the state where an enumeration that
      // stopped at the agent-derived items would read as complete and be wrong.
      stillDisclosesPurposeIsSent: pane.innerText.includes("what you say agents are for"),
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
  // Ask mode on a Mac whose reviewer CANNOT run. The card must not tell anyone
  // to turn on the checkbox one row down, because that checkbox is dead.
  saveSettings(probeHome, { ...loadSettings(probeHome), relayCredential: "" });
  win.webContents.send("status:changed");
  await waitFor(
    win,
    `document.querySelector("#view").innerText.includes("cannot suggest an answer")`,
    "the Ask card to say why there is no suggestion on offer",
  );
  const askWithoutReviewer = await win.webContents.executeJavaScript(`(${() => {
    const pane = document.querySelector("#view");
    const box = [...pane.querySelectorAll("input")].find(
      (i) => i.type === "checkbox" &&
        (i.closest("label")?.textContent ?? "").includes("Let the reviewer suggest"),
    );
    return {
      // The dead-end sentence is gone…
      noDeadInstruction: !pane.innerText.includes("turn that on below"),
      // …replaced by the reason, and the checkbox it described really is dead.
      explainsWhy: pane.innerText.includes("cannot suggest an answer"),
      checkboxIsDead: !!box && box.disabled,
      // …and it names the one remedy there is, which is a control that exists.
      namesTheRemedy: pane.innerText.includes("sign in to Plow in Settings"),
      // Ask mode still says what Ask mode does.
      stillSaysWhatAskDoes: pane.innerText.includes(
        "Any request a rule doesn't already cover opens an approval window",
      ),
    };
  }})()`);
  saveSettings(probeHome, {
    ...loadSettings(probeHome),
    relayCredential: "plow_sk_probe_credential",
  });
  win.webContents.send("status:changed");
  await waitFor(win, `document.querySelector("#view").innerText.includes("turn that on below")`,
    "the Ask card to go back to offering the suggestion");

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

  // Unsaved edits must not vanish without a word. The vault is the only screen
  // that holds a form open behind a Save button, so it is the only one where
  // leaving can throw typing away — by closing the sheet, by collapsing a row,
  // or by switching tab out from under it.
  const vaultUnsaved = await (async () => {
    vaultItemsReply = [{ id: "itm1", type: "login", title: "Notion", subtitle: "owner@probe", urls: ["https://notion.so"] }];
    const js = (fn) => win.webContents.executeJavaScript(`(${fn})()`);
    const click = (sel) => win.webContents.executeJavaScript(
      `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return false; n.click(); return true; })()`);
    // A real keystroke, not an assignment: the dirty flag rides the input event.
    const type = (sel, value) => win.webContents.executeJavaScript(
      `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return false;
         n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    const asking = () => js(() => !!document.querySelector(".vaultui .confirm-overlay"));
    // Fire-and-forget: selectTab's promise stays pending until the confirm is
    // answered, so awaiting it would deadlock against the click that answers it.
    const leaveTab = (tab) => win.webContents.executeJavaScript(
      `(() => { window.__domoSelectTab(${JSON.stringify(tab)}); return true; })()`);
    const CONFIRM = ".vaultui .confirm-overlay";
    const waitAsking = () => waitFor(win, `document.querySelector("${CONFIRM}")`, "the discard confirmation");
    const waitAnswered = () => waitFor(win, `!document.querySelector("${CONFIRM}")`, "the confirmation to close");

    const SHEET = ".vaultui .overlay.show:not(.confirm-overlay)";
    const NAME = ".vaultui .sheet input[data-name='1']";
    const KEEP = ".vaultui .confirm-overlay .btn.ghost";
    const DISCARD = ".vaultui .confirm-overlay .btn.danger";

    // The pane is already showing the LOCKED vault from the check above, and
    // re-selecting the tab you are on is deliberately a no-op now — so go away
    // and come back to make it re-read the (now populated) stub.
    await win.webContents.executeJavaScript(`(() => { window.__domoSelectTab("rules"); return true; })()`);
    await waitFor(win, `!document.querySelector(".vaultui")`, "the vault pane to go");
    await win.webContents.executeJavaScript(`(() => { window.__domoSelectTab("vault"); return true; })()`);
    await waitFor(win, `document.querySelector(".vaultui .vitem")`, "the vault list to render");

    // An untouched sheet closes without a question.
    await click(".vaultui .btn-primary");
    await waitFor(win, `document.querySelector("${SHEET}")`, "the new-item sheet");
    await click(".vaultui .ptype[data-new='login']");
    await waitFor(win, `document.querySelector("${NAME}")`, "the login form");
    await click(".vaultui .sheet-foot .btn.ghost");
    await waitFor(win, `!document.querySelector(".vaultui .overlay.show")`, "the sheet to close");
    const cleanSheetClosesFreely = !(await asking()) && !(await js(() => !!document.querySelector(".vaultui .overlay.show")));

    // A filled sheet asks, and backing out leaves the typing where it was.
    await click(".vaultui .btn-primary");
    await waitFor(win, `document.querySelector("${SHEET}")`, "the sheet again");
    await click(".vaultui .ptype[data-new='login']");
    await waitFor(win, `document.querySelector("${NAME}")`, "the login form");
    await type(NAME, "half-typed");
    await click(".vaultui .sheet-foot .btn.ghost");
    await waitAsking();
    const dirtySheetAsks = await asking();
    await click(KEEP);
    await waitAnswered();
    const keepKeepsTheTyping = await win.webContents.executeJavaScript(
      `document.querySelector("${NAME}")?.value === "half-typed"`);

    // Discard is the other answer, and it does close.
    await click(".vaultui .sheet-foot .btn.ghost");
    await waitAsking();
    await click(DISCARD);
    await waitFor(win, `!document.querySelector(".vaultui .overlay.show")`, "the sheet to go");
    const discardClosesSheet = await js(() => !document.querySelector(".vaultui .overlay.show"));

    // Collapsing an edited row is the same loss through a different door.
    await click(".vaultui .vitem .vrow");
    await waitFor(win, `document.querySelector(".vaultui .vitem.open input[data-name='1']")`, "the row's form");
    await type(".vaultui .vitem.open input[data-name='1']", "renamed");
    await click(".vaultui .vitem .vrow");
    await waitAsking();
    const dirtyRowAsksOnCollapse = await asking();
    await click(KEEP);
    await waitAnswered();
    const rowStaysOpenOnKeep = await js(() => !!document.querySelector(".vaultui .vitem.open"));

    // And so is walking off the tab entirely.
    await leaveTab("rules");
    await waitAsking();
    const dirtyBlocksTabSwitch =
      (await asking()) && (await js(() => document.querySelector("#seg button.active")?.dataset.tab === "vault"));
    await click(DISCARD);
    await waitFor(win, `document.querySelector("#seg button.active")?.dataset.tab === "rules"`, "the tab to switch");
    const discardAllowsTabSwitch = await js(() => document.querySelector("#seg button.active")?.dataset.tab === "rules");

    // A second editor cannot be opened over a dirty one without asking — this is
    // what keeps a save/reload from silently taking another form down with it.
    await win.webContents.executeJavaScript(`(() => { window.__domoSelectTab("vault"); return true; })()`);
    await waitFor(win, `document.querySelector(".vaultui .vitem")`, "the vault list again");
    await click(".vaultui .vitem .vrow");
    await waitFor(win, `document.querySelector(".vaultui .vitem.open input[data-name='1']")`, "the row's form");
    await type(".vaultui .vitem.open input[data-name='1']", "dirty-again");
    await click(".vaultui .btn-primary"); // New, over a dirty row
    await waitAsking();
    const secondEditorAsks = await asking();
    await click(KEEP);
    await waitAnswered();
    const refusedSecondEditorKeepsRow = await js(() =>
      document.querySelector(".vaultui .vitem.open input[data-name='1']")?.value === "dirty-again"
      && !document.querySelector(".vaultui .overlay.show"));

    // Clicking the tab you are already on is not navigation, and must not
    // quietly rebuild the pane out from under that still-dirty row.
    await win.webContents.executeJavaScript(`(() => { window.__domoSelectTab("vault"); return true; })()`);
    const resel = await js(() => ({
      asked: !!document.querySelector(".vaultui .confirm-overlay"),
      kept: document.querySelector(".vaultui .vitem.open input[data-name='1']")?.value === "dirty-again",
    }));
    const reselectingVaultKeepsTheForm = !resel.asked && resel.kept;

    // A leave question already in flight must be SHARED, not answered twice and
    // never treated as consent by a second teardown path arriving behind it.
    // The row above is still open, still dirty, and still holds the seat.
    let replies = 0;
    const countReply = () => { replies += 1; };
    ipcMain.on("ui:confirmLeaveReply", countReply);
    win.webContents.send("ui:confirmLeave");
    // ...and a row collapse arriving at the same moment, which reaches the
    // dialog by a different route than the window teardown does.
    await click(".vaultui .vitem .vrow");
    await waitAsking();
    const oneDialogForTwoAskers = await js(() =>
      document.querySelectorAll(".vaultui .confirm-overlay").length === 1);
    await click(KEEP);
    await waitAnswered();
    const refusalIsReported = await waitForNode(() => replies >= 1, "the renderer's refusal")
      .then(() => true).catch(() => false);
    ipcMain.removeListener("ui:confirmLeaveReply", countReply);
    const refusedCloseKeepsTheForm = await js(() =>
      document.querySelector(".vaultui .vitem.open input[data-name='1']")?.value === "dirty-again");

    // Closing the window asks the same question main-side (Cmd-W and Quit both
    // route through it). Drive the renderer's half of that conversation.
    let closeAnswer = null;
    ipcMain.once("ui:confirmLeaveReply", (_e, ok) => { closeAnswer = ok; });
    win.webContents.send("ui:confirmLeave");
    await waitAsking();
    const windowCloseAsks = await asking();
    await click(DISCARD);
    await waitForNode(() => closeAnswer !== null, "the renderer's answer to main");
    const windowCloseAnswersMain = closeAnswer === true;
    // Consent must TAKE the form away, not just release it: quit spends seconds
    // shutting down, and a form still on screen is a form still being typed into.
    const consentClosesTheForm = await waitFor(win, `!document.querySelector(".vaultui .vitem.open")`,
      "the approved form to be taken away").then(() => true).catch(() => false);

    // ---- An edit that ends where it started is not an edit ----
    // Daniel -> Carlos -> Daniel leaves nothing to save, so leaving must not
    // ask. Start from a row opened clean, so the baseline is what is stored.
    await win.webContents.executeJavaScript(`(() => { window.__domoSelectTab("vault"); return true; })()`);
    await waitFor(win, `document.querySelector(".vaultui .vitem")`, "the vault list for the revert check");
    await click(".vaultui .vitem .vrow");
    const BOX = ".vaultui .vitem.open input[data-name='1']";
    await waitFor(win, `document.querySelector("${BOX}")`, "a freshly opened row");
    const original = await js(() => document.querySelector(".vaultui .vitem.open input[data-name='1']").value);

    // Away from the original, leaving DOES ask - without this the revert below
    // would pass on a form that simply never went dirty.
    await type(BOX, original + "-changed");
    await leaveTab("rules");
    await waitAsking();
    const editedStillAsks = await asking();
    await click(KEEP);
    await waitAnswered();

    // Back to the original: nothing to save, so nothing is asked.
    await type(BOX, original);
    await leaveTab("rules");
    const revertedSwitched = await waitFor(win,
      `document.querySelector("#seg button.active")?.dataset.tab === "rules"`,
      "the tab to switch with nothing left to save").then(() => true).catch(() => false);
    const revertAskedNothing = revertedSwitched && !(await asking());

    // Revealing a secret fills the box from the vault. Looking is not editing.
    await win.webContents.executeJavaScript(`(() => { window.__domoSelectTab("vault"); return true; })()`);
    await waitFor(win, `document.querySelector(".vaultui .vitem")`, "the vault list for the reveal check");
    await click(".vaultui .vitem .vrow");
    await waitFor(win, `document.querySelector(".vaultui .vitem.open .field.secret .eye")`, "the reveal button");
    await click(".vaultui .vitem.open .field.secret .eye");
    await waitFor(win, `document.querySelector(".vaultui .vitem.open .field.secret input").value !== ""`,
      "the secret to land in the box");
    await leaveTab("rules");
    const revealSwitched = await waitFor(win,
      `document.querySelector("#seg button.active")?.dataset.tab === "rules"`,
      "the tab to switch after only looking").then(() => true).catch(() => false);
    const revealAloneIsClean = revealSwitched && !(await asking());
    // Leave nothing open behind this block: a dialog still up would deadlock
    // the next awaited __domoSelectTab in the sections that follow.
    if (await asking()) { await click(DISCARD); await waitAnswered(); }
    await leaveTab("rules");
    await waitFor(win, `document.querySelector("#seg button.active")?.dataset.tab === "rules"`, "a clean exit from the vault block");

    // ---- A form with a vault call in flight takes no input ----
    // Every one of those awaits ends by overwriting or replacing the form, so a
    // keystroke landing mid-flight is lost. Disabling only the control that was
    // clicked left that window open three separate times.
    holdReveal = true;
    await win.webContents.executeJavaScript(`(() => { window.__domoSelectTab("vault"); return true; })()`);
    await waitFor(win, `document.querySelector(".vaultui .vitem")`, "the vault list for the busy check");
    await click(".vaultui .vitem .vrow");
    await waitFor(win, `document.querySelector(".vaultui .vitem.open .field.secret .eye")`, "the eye for the busy check");
    await click(".vaultui .vitem.open .field.secret .eye");
    await waitForNode(() => releaseReveal !== null, "the reveal to be in flight");
    // Mid-flight the WHOLE pane is inert, not just the form that asked: the
    // reload replaces the pane, so a sibling row edited meanwhile would go with
    // it. Both the name box and every OTHER row must be inside that subtree.
    const frozenWhileBusy = await js(() => {
      const pane = document.querySelector(".vaultui[inert]");
      return !!pane
        && !!pane.querySelector("input[data-name='1']")
        && pane.querySelectorAll(".vrow").length === document.querySelectorAll(".vaultui .vrow").length;
    });
    releaseReveal();
    releaseReveal = null;
    holdReveal = false;
    await waitFor(win, `document.querySelector(".vaultui .vitem.open .field.secret input").value !== ""`,
      "the held reveal to land once released");
    const thawedAfterBusy = await js(() => !document.querySelector(".vaultui[inert]"));
    await click(".vaultui .vitem .vrow");
    await waitFor(win, `!document.querySelector(".vaultui .vitem.open")`, "the busy-check row to close");

    // ---- Cmd-W during an in-flight SAVE must still get an answer ----
    // The question is drawn INSIDE the pane, which is inert while the call runs.
    // Raised then it could not be answered, and the reload that ends a
    // successful save would detach it unanswered — stranding main's no-timeout
    // wait and every later close. A held SAVE is the transaction that reloads;
    // a held reveal never replaces the pane and would miss this entirely.
    holdSave = true;
    await win.webContents.executeJavaScript(`(() => { window.__domoSelectTab("vault"); return true; })()`);
    await waitFor(win, `document.querySelector(".vaultui .vitem")`, "the vault list for the close-during-save check");
    await click(".vaultui .vitem .vrow");
    await waitFor(win, `document.querySelector(".vaultui .vitem.open input[data-name='1']")`, "the row for the close-during-save check");
    await type(".vaultui .vitem.open input[data-name='1']", "edited-then-saved");
    await click(".vaultui .vitem.open .btn.save");
    await waitForNode(() => releaseSave !== null, "the save to be in flight");

    let busyCloseAnswer = null;
    const onBusyReply = (_e, ok) => { busyCloseAnswer = ok; };
    ipcMain.on("ui:confirmLeaveReply", onBusyReply);
    win.webContents.send("ui:confirmLeave");
    const noDialogUnderInert = await js(() => !document.querySelector(".vaultui .confirm-overlay"));

    releaseSave();
    releaseSave = null;
    holdSave = false;
    // The save landed and released the form, so there is nothing left to ask
    // about: main gets its answer, and no dialog is orphaned behind the reload.
    const closeAnsweredAfterSave = await waitForNode(() => busyCloseAnswer !== null,
      "main's answer once the save landed").then(() => busyCloseAnswer === true).catch(() => false);
    ipcMain.removeListener("ui:confirmLeaveReply", onBusyReply);
    const noOrphanedDialog = await js(() => !document.querySelector(".vaultui .confirm-overlay"));

    vaultItemsReply = { locked: true, reason: "undecryptable" };
    return {
      cleanSheetClosesFreely, dirtySheetAsks, keepKeepsTheTyping, discardClosesSheet,
      dirtyRowAsksOnCollapse, rowStaysOpenOnKeep, dirtyBlocksTabSwitch, discardAllowsTabSwitch,
      secondEditorAsks, refusedSecondEditorKeepsRow, windowCloseAsks, windowCloseAnswersMain,
      reselectingVaultKeepsTheForm,
      oneDialogForTwoAskers, refusalIsReported, refusedCloseKeepsTheForm,
      consentClosesTheForm,
      editedStillAsks, revertAskedNothing, revealAloneIsClean,
      frozenWhileBusy, thawedAfterBusy,
      noDialogUnderInert, closeAnsweredAfterSave, noOrphanedDialog,
    };
  })();

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
    vaultUnsaved.cleanSheetClosesFreely &&
    vaultUnsaved.dirtySheetAsks &&
    vaultUnsaved.keepKeepsTheTyping &&
    vaultUnsaved.discardClosesSheet &&
    vaultUnsaved.dirtyRowAsksOnCollapse &&
    vaultUnsaved.rowStaysOpenOnKeep &&
    vaultUnsaved.dirtyBlocksTabSwitch &&
    vaultUnsaved.discardAllowsTabSwitch &&
    vaultUnsaved.secondEditorAsks &&
    vaultUnsaved.refusedSecondEditorKeepsRow &&
    vaultUnsaved.windowCloseAsks &&
    vaultUnsaved.windowCloseAnswersMain &&
    vaultUnsaved.reselectingVaultKeepsTheForm &&
    vaultUnsaved.oneDialogForTwoAskers &&
    vaultUnsaved.refusalIsReported &&
    vaultUnsaved.refusedCloseKeepsTheForm &&
    vaultUnsaved.consentClosesTheForm &&
    vaultUnsaved.editedStillAsks &&
    vaultUnsaved.revertAskedNothing &&
    vaultUnsaved.revealAloneIsClean &&
    vaultUnsaved.frozenWhileBusy &&
    vaultUnsaved.thawedAfterBusy &&
    vaultUnsaved.noDialogUnderInert &&
    vaultUnsaved.closeAnsweredAfterSave &&
    vaultUnsaved.noOrphanedDialog &&
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
    cloudRoster.aboveConnect &&
    cloudRoster.showsName &&
    cloudRoster.showsChat &&
    cloudRoster.showsProvider &&
    cloudRoster.status === "Active" &&
    cloudRoster.hasActions &&
    cloudRoster.noCredentialIdentity &&
    cloudPicker.listsEveryChat &&
    cloudPicker.warnsIrreversible &&
    cloudPicker.labelsOptionalName &&
    cloudModalGuard.ignored &&
    cloudModalGuard.keptOriginal &&
    cloudNewChat.twoRoutes &&
    cloudNewChat.serverNumber &&
    cloudNewChat.groupRoute &&
    cloudSettingsPanel.threeControls &&
    cloudSettingsPanel.storedValues &&
    cloudSettingsPanel.restartScoped &&
    cloudSettingsPanel.localWithoutRestart &&
    cloudSettingsPanel.appliesTogether &&
    cloudUpdating.exactCopy &&
    cloudUpdating.controlsDisabled &&
    cloudUpdating.canClose &&
    cloudUpdating.rowStillListed &&
    cloudSettings.stableId &&
    cloudSettings.exactSettings &&
    cloudSettingsFailure.showsFailure &&
    cloudSettingsFailure.priorServerSettings &&
    cloudSettingsFailure.localSettingApplied &&
    cloudSettingsFailure.controlsEnabled &&
    cloudSettingsFailure.rowStillListed &&
    cloudUnknown.bothIndeterminate &&
    cloudUnknown.bothNamedUnknown &&
    cloudUnknown.explainsUnknown &&
    cloudUnknown.noOtherAgentError &&
    cloudUnknown.localOnlyAllowed &&
    cloudUnknownChoice.oneChoiceBlocked &&
    cloudUnknownChoice.bothChoicesAllowed &&
    cloudUnknownChoice.noLongerGuesses &&
    cloudUnknownLocalOnly.stableId &&
    cloudUnknownLocalOnly.untouchedPermissions &&
    cloudUnknownLocalOnly.reviewApplied &&
    cloudUnknownLocalOnly.noRestart &&
    cloudChatFailure.showsError &&
    cloudChatFailure.notEmptyState &&
    cloudChatFailure.keepsRoster &&
    cloudForbidden.ordinaryError &&
    cloudForbidden.noSpecialState &&
    cloudForbidden.keepsRoster &&
    cloudEmpty.literal &&
    cloudEmpty.noNumber &&
    cloudEmpty.noExplanation &&
    settings.hasAccountGroup &&
    settings.showsThisMac &&
    settings.noEndpointRow &&
    settings.noAccountUid &&
    settings.noPhonePromise &&
    settings.offersNoRelayKeyField &&
    !settings.bodyLeaksKey &&
    settings.noReviewerGroup &&
    settings.noPasswordField &&
    settings.noSuggestionsCheckbox &&
    settings.hasCapabilitiesGroup &&
    settings.fdaSaysNotGranted &&
    settings.fdaNamesMessages &&
    settings.fdaOffersSystemSettings &&
    settings.supportMarks &&
    settings.launchTitle &&
    settings.launchToggleLive &&
    settings.launchNoteHidden &&
    staleSettingsPane.launchUnsupportedFollowed &&
    strandedOnDisk.keyNotInDom &&
    strandedOnDisk.scrubbedFromDisk &&
    strandedOnDisk.reviewerStillUsable &&
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
    approvalsReviewer.purposeExampleHasBoundary &&
    approvalsReviewer.labelled &&
    approvalsReviewer.saysItCanWiden &&
    approvalsReviewer.noOnlyNarrowsClaim &&
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
    approvalsAsk.stillDisclosesPurposeIsSent &&
    askWithoutReviewer.noDeadInstruction &&
    askWithoutReviewer.explainsWhy &&
    askWithoutReviewer.checkboxIsDead &&
    askWithoutReviewer.namesTheRemedy &&
    askWithoutReviewer.stillSaysWhatAskDoes &&
    settings.noApprovalModeGroup &&
    settings.noModeChipsHere &&
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
      JSON.stringify({ main, settings, strandedOnDisk, settingsPane, connect, cloudRoster, cloudPicker, cloudModalGuard, cloudNewChat, cloudSettingsPanel, cloudUpdating, cloudSettings, cloudSettingsFailure, cloudUnknown, cloudUnknownChoice, cloudUnknownLocalOnly, cloudChatFailure, cloudForbidden, cloudEmpty, agentsShot, approvalsReviewer, approvalsShot, purposeRoundTrip, approvalsAsk, askWithoutReviewer, approvalsShotAsk, agentsOpen, modalClosed, vaultLocked, vaultUnsaved, vaultShot, agentsOpenShot, staleSettingsPane, optimisticMode, settingsShot, approval, reviewerNote, consoleErrors: errors, ok }),
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
