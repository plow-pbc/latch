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
import { capabilitiesView } from "../dist/capabilitiesModel.js";
import { grantList, pluginRows } from "../dist/pluginsModel.js";
import { parseManifest } from "@domo/device-core";

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
let gatekeeperActivity = {
  id: "activity-gatekeeper-probe",
  ts: "2026-09-20T19:00:00.000Z",
  blockedAt: null,
  decision: "Denied",
  decisionTone: "red",
  status: "",
  tone: "zinc",
  title: "Buy a $125 Lego set on Amazon",
  kind: "command",
  decisionKind: "denied",
  statusKind: "none",
  command: "open https://amazon.com/lego",
  agentId: "agent-family",
  agentDisplay: "Family assistant",
  goal: "Buy a birthday present",
  decidedBy: "AI Reviewer",
  decisionSource: "adversarial",
  reviewReason: "Purchases are not covered by the current family-assistant instructions.",
  intentId: "intent-gatekeeper-probe",
  exitCode: null,
  capabilities: ["Browser: amazon.com"],
  timeline: [{ text: "Denied by Gatekeeper", state: "bad", at: "2026-09-20T19:00:01.000Z" }],
};
let auditCleared = false;
let holdAuditClear = false;
let resolveAuditClear = null;
ipcMain.handle("audit:page", async () => {
  const rows = auditCleared ? [] : [gatekeeperActivity];
  return { rows, total: rows.length, size: rows.length };
});
ipcMain.handle("audit:activity", async (_event, id) =>
  !auditCleared && id === gatekeeperActivity.id ? gatekeeperActivity : null);
ipcMain.handle("audit:clear", async (event) => {
  if (holdAuditClear) {
    await new Promise((resolve) => { resolveAuditClear = resolve; });
  }
  auditCleared = true;
  gatekeeperRecoveryProbe = null;
  event.sender.send("gatekeeperRecovery:changed");
  return true;
});
ipcMain.handle("status:get", async () => ({ deviceId: "probe", name: "Probe", connected: false }));
ipcMain.handle("rules:list", async () => []);
let gatekeeperRecoveryProbe = {
  intentId: "intent-gatekeeper-probe",
  agent: "Family assistant",
  request: "Buy a $125 Lego set on Amazon",
  capabilities: ["Browser: amazon.com"],
  reason: "Purchases are not covered by the current family-assistant instructions.",
};
let holdGatekeeperRecoveryGet = false;
let resolveGatekeeperRecoveryGet = null;
ipcMain.handle("gatekeeperRecovery:get", async () => {
  if (!holdGatekeeperRecoveryGet) return gatekeeperRecoveryProbe;
  return new Promise((resolve) => { resolveGatekeeperRecoveryGet = resolve; });
});
ipcMain.handle("gatekeeperRecovery:dismiss", async (_event, intentId) => {
  if (gatekeeperRecoveryProbe?.intentId === intentId) gatekeeperRecoveryProbe = null;
  return gatekeeperRecoveryProbe;
});
const recoverySuggestion = {
  ok: true,
  revision: "You are a tool a family assistant uses; you are authorized to make purchases for the family.",
};
let holdRecoverySuggestion = false;
let resolveRecoverySuggestion = null;
let lastSuggestedActivityId = null;
ipcMain.handle("gatekeeperRecovery:suggest", async (_event, activityId) => {
  lastSuggestedActivityId = activityId;
  if (!holdRecoverySuggestion) return recoverySuggestion;
  return new Promise((resolve) => { resolveRecoverySuggestion = resolve; });
});
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
// A Mac that has NOT granted Full Disk Access — the state Settings'
// Permissions section exists to explain. It renders from the REAL view model
// (capabilitiesModel.ts) over this stub inventory: Full Disk Access off, and
// nothing else asked for. `grant:state` is what the floating grant panel polls.
const probeInventory = {
  checked_at: "2026-09-02T08:00:00Z",
  full_disk_access: { granted: false, probes: [] },
  automation: [],
  automation_queryable: true,
  permissions: [
    { permission: "accessibility", status: "denied" },
    { permission: "contacts", status: "not_asked" },
    { permission: "calendars", status: "granted" },
  ],
  sandbox: { status: "ok", detail: null },
  child_attribution: { status: "not_applicable", detail: null },
  vault_key: { status: "ok", reason: null },
};
const probeCapabilities = () => ({
  fullDiskAccess: false,
  inventory: probeInventory,
  view: capabilitiesView({ inventory: probeInventory, automation: [], events: [], dismissals: {}, bannerSeenAt: null }),
});
// Answered late on purpose: on a Mac where a target app is not answering
// Apple events this read is a 3s probe timeout, and the Settings pane must be
// on screen before it lands (#446). The assertion is below, at the tab switch.
const CAPABILITIES_DELAY_MS = 1500;
ipcMain.handle("capabilities:get", async () => {
  await new Promise((r) => setTimeout(r, CAPABILITIES_DELAY_MS));
  return probeCapabilities();
});
ipcMain.handle("capabilities:act", async () => probeCapabilities().view);
ipcMain.handle("capabilities:dismiss", async () => probeCapabilities().view);
ipcMain.handle("capabilities:bannerSeen", async () => probeCapabilities().view);
ipcMain.handle("grant:state", async () => ({ key: "full_disk_access", label: "Full Disk Access", granted: false }));
// The Plugins tab renders from the REAL view model (pluginsModel.ts) over the
// SHIPPED gog manifest, read off disk: what the tab tells the owner is what the
// file declares. Like main, it knows the Google accounts only once a connector
// refresh has asked. The off switch and a requirement's button answer with the
// fresh state, as main does; the button's act lands nothing here.
const probePlugins = { gog: true };
const probeStaged = [{
  manifest: parseManifest(fs.readFileSync(path.join(dir, "../plugins/gog/latch-plugin.json"), "utf8")),
  description: "Gmail and Calendar, through gog.",
}];
const probePluginRows = () => {
  const rows = pluginRows({
    plugins: probeStaged.map((p) => ({ ...p, enabled: probePlugins[p.manifest.name] })),
    connectedAccounts: probeAccountsLoaded && connectorProbe.google.accounts.length ? ["google"] : [],
    grantedPermissions: [],
    relaunchPending: [],
  });
  return { rows, grants: grantList(rows) };
};
ipcMain.handle("plugins:get", async () => probePluginRows());
ipcMain.handle("plugins:setEnabled", async (_e, name, on) => {
  probePlugins[name] = on === true;
  return probePluginRows();
});
ipcMain.handle("requirements:act", async () => ({ ...probePluginRows(), error: null }));
// The drag-to-authorize tile's display data: a fake bundle name and a 1px
// icon, so the tile renders in the probe without a real .app behind it.
ipcMain.handle("fullDisk:dragInfo", async () => ({
  name: "Plow Latch",
  iconDataUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
}));
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
// Keep Mac Awake: a boolean stub — the probe proves the pane's wiring, and
// keepAwake.test.ts owns the lifecycle. No caffeinate child in the probe.
let keepAwakeOn = false;
ipcMain.handle("power:getKeepAwake", async () => ({ enabled: keepAwakeOn }));
ipcMain.handle("power:setKeepAwake", async (_e, on) => ({ enabled: (keepAwakeOn = !!on) }));
// The Privacy toggle: same boolean-stub shape as Keep Mac Awake. The probe
// proves the pane renders; telemetry.test.ts owns what the setting gates.
let telemetryOn = true;
ipcMain.handle("telemetry:get", async () => ({ enabled: telemetryOn }));
ipcMain.handle("telemetry:set", async (_e, on) => ({ enabled: (telemetryOn = !!on) }));
// These four are the real handlers, running the real guards against real
// on-disk settings. A signed-in Mac with no Anthropic key: Plow is usable and
// selected, the Anthropic provider is not.
ipcMain.handle("settings:getInference", async () => readInference(probeHome));
// The purpose statement, through the real setter — the one path that may write
// it. Nothing an agent can reach registers a handler on either channel.
ipcMain.handle("settings:getAgentPurpose", async () => readAgentPurpose(probeHome));
ipcMain.handle("settings:setAgentPurpose", async (_e, purpose) => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  return setAgentPurpose(probeHome, purpose);
});
const cloudThreadTitle = "Willow · You · Robin";
const cloudAgent = {
  agentId: "cag_probe",
  name: "Household helper",
  provider: "exe:life",
  line: { uid: "lin_willow", label: "Willow · +1 415-555-0142" },
  canMessage: true,
  threads: [{ uid: "chat_probe", label: cloudThreadTitle }],
  status: "running",
  failureReason: null,
  createdAt: "2026-08-24T18:00:00.000Z",
};
const rosterProbe = [{
  id: 202,
  name: "Claude Code",
  createdAt: "2026-08-23T18:00:00.000Z",
  lastSeenAt: "2026-08-25T17:50:00.000Z",
  chatUids: ["*"],
  chatAccess: "all",
  permissions: { canReadAndReply: true, canSpendInference: true },
  deviceLabel: "this Mac",
}];
let cloudProbe = {
  cloudAgents: [cloudAgent],
  cloudProviders: [
    { id: "exe:hermes", name: "Hermes" },
    { id: "exe:life", name: "Life" },
  ],
  cloudProvidersError: null,
  cloudFreeLines: [{ uid: "lin_ash", label: "Ash · +1 415-555-0199" }],
  cloudAgentsError: null,
  cloudChatsError: null,
  cloudChatsNeedReactivation: false,
  cloudActionError: null,
  cloudChatsLoaded: true,
  cloudLinesLoaded: true,
};
const cloudMessageAgentIds = [];
let staticCreateCount = 0;

// Connect state also carries the cloud-agent display state. It contains no
// credential, session id or worker URL.
/** The Agents tab's whole state, as main assembles it. */
const agentsTabProbeState = () => ({
  mcpUrl: "https://api.plow.co/v1/relay/devices/u_probe/mcp",
  accountUid: "u_probe",
  connected: true,
  hasCredential: true,
  busy: false,
  message: "",
  credential: null,
  roster: rosterProbe,
  rosterError: null,
  actionError: null,
  ...cloudProbe,
});
ipcMain.handle("connect:get", async () => agentsTabProbeState());
ipcMain.handle("connect:create", () => { staticCreateCount += 1; return agentsTabProbeState(); });
ipcMain.handle("connect:dismiss", () => { cloudProbe.credential = null; });
ipcMain.handle("cloud:refresh", async () => agentsTabProbeState());
ipcMain.handle("cloud:openMessages", async (_e, agentId) => {
  if (typeof agentId === "string") cloudMessageAgentIds.push(agentId);
  return true;
});
ipcMain.handle("cloud:remove", async (_e, agentId) => {
  cloudProbe = {
    ...cloudProbe,
    cloudAgents: cloudProbe.cloudAgents.filter((agent) => agent.agentId !== agentId),
  };
  return agentsTabProbeState();
});
ipcMain.handle("settings:signOut", async () => {});
const connectorProbe = {
  busy: false,
  message: "",
  noteKind: "error",
  google: {
    connecting: false,
    accounts: [
      { email: "owner@probe.test", isDefault: true },
      { email: "work@probe.test", isDefault: false },
    ],
  },
};
let probeAccountsLoaded = false;
ipcMain.handle("connectors:refresh", async (e) => {
  probeAccountsLoaded = true;
  e.sender.send("connectors:changed", connectorProbe);
  return connectorProbe;
});
ipcMain.handle("connectors:connect", async () => connectorProbe);
ipcMain.handle("connectors:disconnect", async () => connectorProbe);
ipcMain.handle("connectors:setDefault", async () => connectorProbe);
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

async function clickCloudButton(win, label) {
  const text = JSON.stringify(label);
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll(".cloud-modal button")]
      .find((button) => button.textContent.trim() === ${text}).click()`,
  );
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
      noRulesTab: !document.querySelector('#seg button[data-tab="rules"]'),
      gatekeeperInAudit: !!document.querySelector("#view .audit-gatekeeper"),
    };
  }})()`);

  // Settings names the Plow account, so render it too and prove the credential
  // never reaches the renderer. There is no key field and no URL field any more:
  // the credential is minted by first-run login and the API origin is baked into
  // the build.
  const switched = Date.now();
  await win.webContents.executeJavaScript(`window.__domoSelectTab && window.__domoSelectTab("settings")`);
  // The pane paints before the permission inventory lands (that read is held
  // back CAPABILITIES_DELAY_MS above), then the rows fill in.
  await waitFor(win, `document.querySelector(".panel.settings")`, "the Settings pane");
  const paintedAfterMs = Date.now() - switched;
  await waitFor(win, `document.querySelector(".panel.settings .cap-row")`, "the permission rows");
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
      // Connected accounts came BACK to this pane with the permission
      // inventory: an account is a prerequisite like a switch, and the
      // machine-configuration view holds both. The Plugins tab shows only
      // what is unmet.
      hasConnectedAccountsHere: [...document.querySelectorAll(".panel.settings .group-title")].some(
        (title) => /connected accounts/i.test(title.textContent),
      ),
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
      // The permission inventory lives here now (probed below); the drag
      // source still lives only in the floating grant panel.
      hasPermissionInventory: document.querySelector("#view").innerText.includes("Full Disk Access"),
      fdaNoInlineDragTile: !document.querySelector(".fda-drag-tile"),
      // The marks split by meaning: the macOS "…" on the one hand-off the user
      // must finish over there (System Settings), the external-link ↗ on the
      // buttons whose click just happens in the browser (Discord, Livestream)
      // — and never both on one button.
      // Both remaining Support buttons (Discord, Livestream) just open a
      // browser, so both carry the arrow; the one hand-off into System
      // Settings is in the Permissions section's rows, not among these.
      supportMarks: (() => {
        const btns = [...document.querySelectorAll(".support-row .btn")];
        const arrowed = btns.filter((b) => b.querySelector(".ext-arrow"));
        const handoffs = btns.filter((b) => b.textContent.trim().endsWith("…"));
        return btns.length === 2 && arrowed.length === 2 && handoffs.length === 0;
      })(),
      // Launch at Login, in Availability: on this packaged-looking probe the
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
      // Keep Mac Awake, beside it: off by default, and the toggle is live —
      // the probe's blocker always grants, so a checked box would mean the
      // renderer showed a state it never asked main for.
      hasAvailabilityGroup: document.body.innerText.includes("Availability"),
      awakeTitle: document.body.innerText.includes("Keep Mac Awake"),
      awakeToggleLiveAndOff: (() => {
        const box = [...document.querySelectorAll(".settings input")].find(
          (i) => i.type === "checkbox" &&
            (i.closest("label")?.textContent ?? "").includes("Keep this Mac awake while plugged in"),
        );
        return !!box && !box.disabled && !box.checked;
      })(),
    };
  }})()`);
  settings.paintedBeforeInventory = paintedAfterMs < CAPABILITIES_DELAY_MS;

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
  await waitFor(win, `document.querySelector(".gatekeeper-mode")?.dataset.mode === "ask"`,
    "the Gatekeeper mode control to show Ask");
  // The credential goes AFTER the pane rendered, with no notification — so the
  // chip is still enabled and the renderer still believes it can select this.
  saveSettings(probeHome, { ...loadSettings(probeHome), relayCredential: "" });
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector(".gatekeeper-mode").click();
    return true;
  })()`);
  await waitFor(win, `[...document.querySelectorAll(".menu-item")].some((item) => item.textContent.includes("Enabled"))`,
    "the Gatekeeper mode menu to open");
  await win.webContents.executeJavaScript(`(() => {
    [...document.querySelectorAll(".menu-item")]
      .find((item) => item.textContent.includes("Enabled")).click();
    return true;
  })()`);
  await waitFor(win, `document.querySelector(".gatekeeper-mode")?.dataset.mode === "adversarial"`,
    "the pane to follow main's acceptance of the reviewer mode");
  const optimisticMode = {
    // Losing the credential no longer rewrites the mode behind the user.
    storedIsAdversarial: loadSettings(probeHome).approvalMode === "adversarial",
    // What the pane claims, against what main actually stored.
    chipAgrees: await win.webContents.executeJavaScript(
      `document.querySelector(".gatekeeper-mode")?.dataset.mode === "adversarial"`,
    ),
    // …and the purpose field follows the MODE, not the credential. The owner
    // picked "AI Reviewer decides" and that choice stands, so what the reviewer
    // will read stays on offer — there is nothing to write it into yet, which
    // the note beside it says.
    purposeFieldStillOffered: await win.webContents.executeJavaScript(
      `!!document.querySelector("#view .gatekeeper-purpose textarea.text")?.checkVisibility()`,
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
  await waitFor(win, `document.querySelectorAll("#view .panel.agents .list-section").length === 2`,
    "the two-section Agents pane");
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll("#view button")].find((b) => b.textContent.trim() === "Connect MCP client").click()`,
  );
  await waitFor(win, `document.querySelector(".connect-modal .connect .client-card")`,
    "the MCP setup modal and its client card");
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
      hasAgentsPane: document.querySelectorAll("#view .panel.agents .list-section").length === 2,
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
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll(".connect-modal button")].find((b) => b.textContent.trim() === "Close").click()`,
  );

  const cloudRoster = await win.webContents.executeJavaScript(`(${() => {
    const group = [...document.querySelectorAll("#view .panel.agents .list-section")]
      .find((item) => item.querySelector("h2")?.textContent.trim() === "Plow Agents");
    const row = group?.querySelector(".cloud-agent-row");
    return {
      noCredentialIdentity: !group?.textContent.includes("session") &&
        !group?.textContent.includes("worker"),
      hidesProvider: !group?.textContent.includes("Provider"),
      namesKindAndLine: row?.querySelector(".entity-context")?.textContent
        .includes("Life · Willow · +1 415-555-0142") === true,
      showsCreated: row?.querySelector(".entity-context")?.textContent
        .includes("Created Aug 24") === true,
      hidesLastUsed: !row?.querySelector(".entity-context")?.textContent.includes("Used "),
      offersMessage: row?.querySelector(".message-btn")?.textContent.trim() === "Message",
      rowIsDetailTrigger: row?.querySelector(".cloud-agent-open")
        ?.getAttribute("role") === "button",
      offersNewAgent: [...group.querySelectorAll("button")]
        .some((button) => button.textContent.trim() === "New agent"),
    };
  }})()`);

  // A static credential says which Mac it works from, by label. The device uid
  // is main-process only and must not be anywhere on the screen.
  const mcpRoster = await win.webContents.executeJavaScript(`(${() => {
    const group = [...document.querySelectorAll("#view .panel.agents .list-section")]
      .find((item) => item.querySelector("h2")?.textContent.trim() === "Other Agents and Clients");
    const context = group?.querySelector(".entity-row .entity-context")?.textContent ?? "";
    return {
      namesBoundDevice: context.includes("Bound to this Mac"),
      stillNamesKind: context.includes("MCP client"),
      noDeviceUid: !document.body.textContent.includes("dev_"),
    };
  }})()`);

  await win.webContents.executeJavaScript(
    `document.querySelector(".cloud-agent-row .message-btn").click()`,
  );
  await waitForNode(
    () => cloudMessageAgentIds.at(-1) === cloudAgent.agentId,
    "the roster Message IPC",
  );

  await win.webContents.executeJavaScript(`document.querySelector(".cloud-agent-row .cloud-agent-open").click()`);
  await waitFor(win, `document.querySelector(".cloud-detail-threads")`, "agent detail");
  const cloudDetail = await win.webContents.executeJavaScript(`(${() => {
    const modal = document.querySelector(".cloud-modal");
    const buttons = [...modal.querySelectorAll("button")].map((button) =>
      button.textContent.trim());
    const fields = [...modal.querySelectorAll(".cloud-detail-field")].map((field) =>
      field.textContent.trim());
    const threads = [...modal.querySelectorAll(".cloud-thread-list li")].map((thread) =>
      thread.textContent.trim());
    return {
      title: modal.querySelector(".group-title")?.textContent.trim(),
      line: fields[0] ?? "",
      status: fields[1] ?? "",
      threads,
      buttons,
      readOnly: !modal.querySelector("input, select, textarea") &&
        !buttons.some((label) => /edit|save/i.test(label)),
    };
  }})()`);

  cloudMessageAgentIds.length = 0;
  await clickCloudButton(win, "Message");
  await waitForNode(
    () => cloudMessageAgentIds.at(-1) === cloudAgent.agentId,
    "the detail Message IPC",
  );

  await clickCloudButton(win, "Delete agent");
  await waitFor(
    win,
    `document.querySelector(".cloud-modal .group-title")?.textContent.startsWith("Delete ")`,
    "the cloud-agent delete confirmation",
  );
  const cloudDeleteConfirm = await win.webContents.executeJavaScript(`(${() => {
    const modal = document.querySelector(".cloud-modal");
    return {
      title: modal.querySelector(".group-title")?.textContent.trim(),
      copy: modal.textContent.includes("The agent will stop reading and replying, and your conversations on this line may be removed. To get another agent, use New agent to send a setup text."),
      buttons: [...modal.querySelectorAll("button")].map((button) => button.textContent.trim()),
    };
  }})()`);
  await clickCloudButton(win, "Cancel");
  await waitFor(
    win,
    `document.querySelector(".cloud-modal .cloud-detail-threads")`,
    "the cloud-agent detail after cancelling delete",
  );

  // Capture the shipping detail view, not only its DOM, so layout regressions
  // in the new line-and-threads surface are visible in the required artifact.
  const agentsShot = process.env.AGENTS_OUT ?? "/tmp/agents.png";
  await captureAfterPaint(win, agentsShot);
  await clickCloudButton(win, "Close");
  await waitFor(win, `!document.querySelector(".cloud-modal")`, "the cloud-agent detail to close");

  cloudProbe = {
    ...cloudProbe,
    cloudAgents: [{ ...cloudAgent, line: null, canMessage: false, threads: [] }],
    cloudChatsError: null,
    cloudChatsLoaded: false,
  };
  // Audit waits on denial state before mounting. Hold that read so this switch
  // proves a stale Audit continuation cannot replace the Agents pane after the
  // owner has already moved on.
  holdGatekeeperRecoveryGet = true;
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await waitForNode(() => resolveGatekeeperRecoveryGet !== null, "the held Gatekeeper attention read");
  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  holdGatekeeperRecoveryGet = false;
  resolveGatekeeperRecoveryGet(gatekeeperRecoveryProbe);
  resolveGatekeeperRecoveryGet = null;
  await waitFor(win, `document.querySelector(".cloud-agent-row .cloud-agent-open")`,
    "the cloud agent whose threads are still loading");
  await win.webContents.executeJavaScript(
    `document.querySelector(".cloud-agent-row .cloud-agent-open").click()`,
  );
  await waitFor(win, `document.querySelector(".cloud-modal .cloud-detail-threads")`,
    "the loading-thread detail");
  const loadingCloudDetail = await win.webContents.executeJavaScript(`(${() => {
    const modal = document.querySelector(".cloud-modal");
    const fields = [...modal.querySelectorAll(".cloud-detail-field")].map((field) =>
      field.textContent.trim());
    return {
      line: fields[0] ?? "",
      threadState: modal.querySelector(".cloud-thread-empty")?.textContent.trim(),
      offersMessage: [...modal.querySelectorAll("button")]
        .some((button) => button.textContent.trim() === "Message"),
    };
  }})()`);
  cloudProbe = {
    ...cloudProbe,
    cloudAgents: [cloudAgent],
    cloudChatsError: null,
    cloudChatsLoaded: true,
  };
  win.webContents.send("connect:changed");
  await waitFor(
    win,
    `document.querySelector(".cloud-modal .cloud-thread-list li")?.textContent.trim() === ${JSON.stringify(cloudThreadTitle)}`,
    "the open cloud-agent detail to refresh with its loaded threads",
  );
  await clickCloudButton(win, "Close");
  await waitFor(win, `!document.querySelector(".cloud-modal")`,
    "the loading-thread detail to close");

  cloudProbe = {
    ...cloudProbe,
    cloudAgents: [{ ...cloudAgent, line: null, canMessage: false, threads: [] }],
    cloudChatsError: "The chat list is unavailable.",
    cloudChatsLoaded: false,
  };
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  await waitFor(win, `document.querySelector(".cloud-agent-row .cloud-agent-open")`,
    "the cloud agent whose threads failed to load");
  await win.webContents.executeJavaScript(
    `document.querySelector(".cloud-agent-row .cloud-agent-open").click()`,
  );
  await waitFor(win, `document.querySelector(".cloud-modal .cloud-detail-threads")`,
    "the unavailable-thread detail");
  const unavailableCloudDetail = await win.webContents.executeJavaScript(`(${() => {
    const modal = document.querySelector(".cloud-modal");
    const fields = [...modal.querySelectorAll(".cloud-detail-field")].map((field) =>
      field.textContent.trim());
    return {
      line: fields[0] ?? "",
      threadState: modal.querySelector(".cloud-thread-empty")?.textContent.trim(),
      hidesRawLineUid: !modal.textContent.includes("lin_willow"),
      offersMessage: [...modal.querySelectorAll("button")]
        .some((button) => button.textContent.trim() === "Message"),
    };
  }})()`);
  await clickCloudButton(win, "Close");
  await waitFor(win, `!document.querySelector(".cloud-modal")`,
    "the unavailable-thread detail to close");

  cloudProbe = {
    ...cloudProbe,
    cloudAgents: [{ ...cloudAgent, status: "failed", failureReason: "Set up failed" }],
  };
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  await waitFor(win, `document.querySelector(".cloud-agent-row .cloud-agent-open")`,
    "the failed cloud agent");
  await win.webContents.executeJavaScript(
    `document.querySelector(".cloud-agent-row .cloud-agent-open").click()`,
  );
  await waitFor(win, `document.querySelector(".cloud-modal .cloud-detail-threads")`,
    "the failed cloud-agent detail");
  const failedCloudDetailButtons = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll(".cloud-modal button")].map((button) => button.textContent.trim())`,
  );
  await clickCloudButton(win, "Close");
  await waitFor(win, `!document.querySelector(".cloud-modal")`, "the failed detail to close");

  // Gatekeeper now lives at the top of Audit: its mode is a title-level menu,
  // and its instructions remain visible in every mode.
  saveSettings(probeHome, {
    ...loadSettings(probeHome),
    relayCredential: "plow_sk_probe_credential",
    approvalMode: "adversarial",
    agentPurpose: "Groceries and calendar only.",
  });
  await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
  await waitFor(win, `document.querySelector(".gatekeeper-mode")?.textContent.includes("Enabled")`,
    "the Gatekeeper card in its reviewer state");
  const approvalsReviewer = await win.webContents.executeJavaScript(`(${() => {
    const pane = document.querySelector("#view");
    const field = pane.querySelector(".gatekeeper-purpose textarea.text");
    return {
      noRulesTab: !document.querySelector('#seg button[data-tab="rules"]'),
      inAudit: !!pane.querySelector(".audit-gatekeeper"),
      title: pane.querySelector(".gatekeeper-title")?.textContent.trim(),
      enabled: pane.querySelector(".gatekeeper-mode")?.textContent.includes("Enabled") ?? false,
      showsStoredPurpose: !!field && field.checkVisibility() && field.value === "Groceries and calendar only.",
      purposeExampleHasBoundary: field?.placeholder.endsWith(
        "Keep it out of everything else on this computer — no files, no other sites.",
      ) ?? false,
      labelled: pane.querySelector(".gatekeeper-field-head label")?.textContent.trim() === "Instructions",
      explainsEnabled: pane.innerText.includes("Requests outside the Plow workspace go to the AI Reviewer."),
      noAdversarialWord: !/adversarial/i.test(pane.innerText),
      recoveryNamesDenial: pane.innerText.includes("Gatekeeper denied this request"),
      recoveryOffersCoaching: pane.innerText.includes("Suggest revised instructions"),
      noRetryOverride: !pane.innerText.includes("Allow one retry") && !pane.innerText.includes("Keep as-is"),
    };
  }})()`);
  await win.webContents.executeJavaScript(`(() => {
    [...document.querySelectorAll(".audit-gatekeeper button")]
      .find((button) => button.textContent.includes("View 0 rules")).click();
    return true;
  })()`);
  await waitFor(win, `document.querySelector(".rules-modal")?.innerText.includes("No always-allow rules")`,
    "the rules preview modal");
  const rulesModalView = await win.webContents.executeJavaScript(`(${() => ({
    opens: !!document.querySelector(".rules-modal"),
    empty: document.querySelector(".rules-modal")?.innerText.includes("No always-allow rules") ?? false,
    explainsPluginReadPrefix: document.querySelector(".rules-modal")?.innerText
      .includes("Plugin read rules also cover any query following the displayed command prefix") ?? false,
  })})()`);
  await win.webContents.executeJavaScript(`(() => {
    [...document.querySelectorAll(".rules-modal button")]
      .find((button) => button.textContent.trim() === "Close").click();
    return true;
  })()`);
  await waitFor(win, `!document.querySelector(".rules-modal")`, "the rules preview modal to close");

  // Only denials made by the AI Reviewer offer prompt coaching. A manual
  // denial remains normal Audit history even if it has the same decision.
  gatekeeperActivity = {
    ...gatekeeperActivity,
    decidedBy: "You (asked)",
    decisionSource: "prompt",
    reviewReason: null,
  };
  win.webContents.send("audit:changed", { ids: [gatekeeperActivity.id] });
  await waitFor(win, `!document.querySelector(".gatekeeper-denial-detail")`,
    "a manual denial to remain plain Audit history");
  approvalsReviewer.manualDenialHasNoCoaching = true;
  gatekeeperActivity = {
    ...gatekeeperActivity,
    decidedBy: "AI Reviewer",
    decisionSource: "adversarial",
    reviewReason: "Purchases are not covered by the current family-assistant instructions.",
  };
  win.webContents.send("audit:changed", { ids: [gatekeeperActivity.id] });
  await waitFor(win, `document.querySelector(".gatekeeper-denial-detail")`,
    "AI Reviewer coaching to return with its Audit record");

  // A historical denial remains actionable after a newer denial arrives: its
  // audit record, not the transient latest-attention notice, owns coaching.
  holdRecoverySuggestion = true;
  await win.webContents.executeJavaScript(`(() => {
    [...document.querySelectorAll(".gatekeeper-denial-detail button")]
      .find((b) => b.textContent.trim() === "Suggest revised instructions").click();
    return true;
  })()`);
  await waitForNode(() => resolveRecoverySuggestion !== null, "the held Gatekeeper suggestion request");
  gatekeeperRecoveryProbe = {
    ...gatekeeperRecoveryProbe,
    intentId: "intent-gatekeeper-newer",
    request: "Send the family itinerary",
  };
  gatekeeperActivity = {
    ...gatekeeperActivity,
    intentId: "intent-gatekeeper-newer",
    title: "Send the family itinerary",
  };
  win.webContents.send("gatekeeperRecovery:changed");
  await waitFor(win, `document.querySelector(".gatekeeper-denial-detail")`,
    "the newer Gatekeeper denial detail");
  resolveRecoverySuggestion(recoverySuggestion);
  resolveRecoverySuggestion = null;
  await win.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 25))`);
  await waitFor(win, `document.querySelector(".gatekeeper-suggestion")`,
    "the historical Gatekeeper suggestion after a newer denial");
  const historicalSuggestionSurvivesNewerDenial = await win.webContents.executeJavaScript(
    `document.querySelector(".gatekeeper-suggestion")?.value.includes("authorized to make purchases for the family")`,
  );
  holdRecoverySuggestion = false;
  gatekeeperRecoveryProbe = {
    ...gatekeeperRecoveryProbe,
    intentId: "intent-gatekeeper-probe",
    request: "Buy a $125 Lego set on Amazon",
  };
  gatekeeperActivity = {
    ...gatekeeperActivity,
    intentId: "intent-gatekeeper-probe",
    title: "Buy a $125 Lego set on Amazon",
  };
  gatekeeperRecoveryProbe = null;
  win.webContents.send("gatekeeperRecovery:changed");
  await waitFor(win, `document.querySelector(".gatekeeper-denial-detail")`,
    "the historical Gatekeeper recovery without live attention");
  const historicalRecovery = {
    visibleWithoutAttention: true,
    usesActivityId: lastSuggestedActivityId === gatekeeperActivity.id,
  };
  const scrollToApprovals = () => win.webContents.executeJavaScript(`(() => {
    document.querySelector(".audit-gatekeeper")?.scrollIntoView({ block: "start" });
    return true;
  })()`);
  // Close the first modal, then ask again for the historical denial. The coach's
  // editable replacement must not apply until Save instructions is clicked.
  await win.webContents.executeJavaScript(`(() => {
    [...document.querySelectorAll(".gatekeeper-suggestion-modal button")]
      .find((b) => b.textContent.trim() === "Cancel")?.click();
    return true;
  })()`);
  await scrollToApprovals();
  const approvalsShot = process.env.APPROVALS_OUT ?? "/tmp/rules-approvals.png";
  await win.webContents.executeJavaScript(
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))`,
  );
  fs.writeFileSync(approvalsShot, (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`(() => {
    [...document.querySelectorAll(".gatekeeper-denial-detail button")]
      .find((b) => b.textContent.trim() === "Suggest revised instructions").click();
    return true;
  })()`);
  await waitFor(win, `document.querySelector(".gatekeeper-suggestion")`, "the editable Gatekeeper suggestion");
  const gatekeeperRecovery = await win.webContents.executeJavaScript(`(${() => ({
    suggestionEditable: !document.querySelector(".gatekeeper-suggestion")?.readOnly,
    suggestionGeneralizes: document.querySelector(".gatekeeper-suggestion")?.value.includes(
      "authorized to make purchases for the family",
    ) ?? false,
    notAppliedAutomatically: document.querySelector("#view .gatekeeper-purpose textarea.text")?.value ===
      "Groceries and calendar only.",
    requiresExplicitUse: [...document.querySelectorAll(".gatekeeper-suggestion-modal button")].some(
      (b) => b.textContent.trim() === "Save instructions",
    ),
    noKeepAction: !document.querySelector(".gatekeeper-denial-detail")?.innerText.includes("Keep as-is"),
    hasDismiss: !!document.querySelector(".gatekeeper-denial-dismiss"),
  })})()`);
  const gatekeeperRecoveryShot = process.env.GATEKEEPER_RECOVERY_OUT ?? "/tmp/gatekeeper-recovery.png";
  await captureAfterPaint(win, gatekeeperRecoveryShot);
  await win.webContents.executeJavaScript(`(() => {
    const field = document.querySelector("#view .gatekeeper-purpose textarea.text");
    field.value = "A pending draft that the coached replacement must supersede.";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await win.webContents.executeJavaScript(`(() => {
    [...document.querySelectorAll(".gatekeeper-suggestion-modal button")]
      .find((b) => b.textContent.trim() === "Save instructions").click();
    return true;
  })()`);
  await waitFor(win, `!document.querySelector(".gatekeeper-suggestion-modal")`,
    "the saved suggestion modal to close");
  await win.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 650))`);
  gatekeeperRecovery.savedAndDismissed = gatekeeperRecoveryProbe === null;
  gatekeeperRecovery.savedPurposeWon = loadSettings(probeHome).agentPurpose === recoverySuggestion.revision;

  // Dismissing the historical helper is local to this selection. Selecting
  // the same durable Audit row again makes its recovery action available.
  await win.webContents.executeJavaScript(`document.querySelector(".gatekeeper-denial-dismiss").click()`);
  await waitFor(win, `!document.querySelector(".gatekeeper-denial-detail")`,
    "the historical Gatekeeper helper to dismiss");
  historicalRecovery.dismissesLocally = true;
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector(".list tbody tr.sel")
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    return true;
  })()`);
  await waitFor(win, `document.querySelector(".gatekeeper-denial-detail")`,
    "the historical Gatekeeper helper to return after reselecting its row");
  historicalRecovery.returnsOnReselect = true;

  // The field autosaves after typing pauses, and what goes back on screen is
  // what the setter stored.
  await win.webContents.executeJavaScript(`(() => {
    const field = document.querySelector("#view .gatekeeper-purpose textarea.text");
    field.value = "  Only household errands.  ";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await waitFor(win, `document.querySelector(".gatekeeper-save-status")?.textContent.includes("Saving")`,
    "the Gatekeeper prompt to show its saving state");
  await waitForNode(() => loadSettings(probeHome).agentPurpose === "Only household errands.",
    "the purpose to reach settings.json through the IPC pair");
  // The field redraws off what main stored, one refresh after the write — the
  // same round-trip the mode chips make below. Reading it the instant the file
  // lands is a race, and on a slow runner the read wins.
  await waitFor(win, `document.querySelector("#view .gatekeeper-purpose textarea.text").value === "Only household errands." && document.querySelector(".gatekeeper-save-status")?.textContent.includes("Saved")`,
    "the purpose field to show what was stored");
  const purposeRoundTrip = {
    stored: loadSettings(probeHome).agentPurpose === "Only household errands.",
    fieldShowsWhatWasStored: await win.webContents.executeJavaScript(
      `document.querySelector("#view .gatekeeper-purpose textarea.text").value === "Only household errands."`,
    ),
  };

  // Cmd-W and Quit ask the renderer before closing. A draft that has not
  // reached its debounce yet must be durably saved before that answer is yes.
  let gatekeeperCloseAnswer = null;
  ipcMain.once("ui:confirmLeaveReply", (_event, ok) => { gatekeeperCloseAnswer = ok; });
  await win.webContents.executeJavaScript(`(() => {
    const field = document.querySelector("#view .gatekeeper-purpose textarea.text");
    field.value = "Close only after this restrictive draft is saved.";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  win.webContents.send("ui:confirmLeave", false);
  await waitForNode(() => gatekeeperCloseAnswer !== null, "the Gatekeeper close answer");
  const gatekeeperCloseFlush = {
    allowed: gatekeeperCloseAnswer === true,
    stored: loadSettings(probeHome).agentPurpose === "Close only after this restrictive draft is saved.",
  };

  // Ask mode stays in the title-level menu. The prompt remains visible, with
  // an honest note that it will be used again when Gatekeeper is Enabled.
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector(".gatekeeper-mode").click();
    return true;
  })()`);
  await waitFor(win, `[...document.querySelectorAll(".menu-item")].some((item) => item.textContent.includes("Ask every time"))`,
    "the Gatekeeper mode menu");
  await win.webContents.executeJavaScript(`(() => {
    [...document.querySelectorAll(".menu-item")]
      .find((item) => item.textContent.includes("Ask every time")).click();
    return true;
  })()`);
  await waitForNode(() => loadSettings(probeHome).approvalMode === "ask",
    "Ask mode to be stored");
  await waitFor(win, `document.querySelector(".gatekeeper-mode")?.dataset.mode === "ask"`,
    "the Gatekeeper card to follow the stored mode");
  const approvalsAsk = await win.webContents.executeJavaScript(`(${() => {
    const pane = document.querySelector("#view");
    const field = pane.querySelector(".gatekeeper-purpose textarea.text");
    return {
      fieldVisible: !!field && field.checkVisibility(),
      explainsAsk: pane.innerText.includes("Requests not already allowed by a rule or the Plow workspace open an approval window."),
      explainsDormantPrompt: pane.innerText.includes(
        "These saved instructions will be used again when Gatekeeper is Enabled.",
      ),
    };
  }})()`);
  const askWithoutReviewer = { noLongerRelevant: true };

  await scrollToApprovals();
  const approvalsShotAsk = process.env.APPROVALS_ASK_OUT ?? "/tmp/rules-approvals-ask.png";
  await win.webContents.executeJavaScript(
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))`,
  );
  fs.writeFileSync(approvalsShotAsk, (await win.webContents.capturePage()).toPNG());

  // A fresh denial on another tab uses one neutral global notice. Review
  // selects its exact Audit row; the notice's × dismisses attention without
  // deleting that row.
  gatekeeperRecoveryProbe = {
    intentId: "intent-gatekeeper-probe",
    agent: "Family assistant",
    request: "Buy a $125 Lego set on Amazon",
    capabilities: ["Browser: amazon.com"],
    reason: "Purchases are not covered by the current family-assistant instructions.",
  };
  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  win.webContents.send("gatekeeperRecovery:changed");
  await waitFor(win, `document.querySelector(".gatekeeper-notice")?.innerText.includes("Buy a $125 Lego set on Amazon")`,
    "the global Gatekeeper denial notice");
  const globalNotice = await win.webContents.executeJavaScript(`(${() => ({
    neutral: getComputedStyle(document.querySelector(".gatekeeper-notice")).display === "flex",
    review: [...document.querySelectorAll(".gatekeeper-notice button")]
      .some((button) => button.textContent.includes("Review in Audit")),
    dismiss: !!document.querySelector(".gatekeeper-notice-dismiss"),
  })})()`);
  win.webContents.send("ui:showGatekeeperRecovery");
  await waitFor(win, `document.querySelector(".gatekeeper-denial-detail")`,
    "the notice to route to the denied Audit activity");
  globalNotice.routed = true;
  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  await waitFor(win, `document.querySelector(".gatekeeper-notice-dismiss")`, "the notice after leaving Audit");
  await win.webContents.executeJavaScript(`document.querySelector(".gatekeeper-notice-dismiss").click()`);
  await waitFor(win, `document.querySelector(".gatekeeper-notice")?.hidden === true`,
    "the global denial notice to dismiss");
  globalNotice.dismissedWithoutDeletingRow = gatekeeperActivity.id === "activity-gatekeeper-probe";

  // Clearing the log also clears attention: there is no longer an activity to
  // attach recovery to, so Audit must not silently retain a hidden denial.
  gatekeeperRecoveryProbe = {
    intentId: "intent-gatekeeper-probe",
    agent: "Family assistant",
    request: "Buy a $125 Lego set on Amazon",
    capabilities: ["Browser: amazon.com"],
    reason: "Purchases are not covered by the current family-assistant instructions.",
  };
  win.webContents.send("gatekeeperRecovery:changed");
  await waitFor(win, `document.querySelector(".gatekeeper-notice")?.hidden === false`,
    "the denial notice before clearing Audit");
  win.webContents.send("ui:showGatekeeperRecovery");
  await waitFor(win, `document.querySelector(".gatekeeper-denial-detail")`,
    "the denial detail before clearing Audit");
  holdAuditClear = true;
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll("#view button")]
      .find((button) => button.textContent.trim() === "Clear Log")
      .click()
  `);
  await waitForNode(() => resolveAuditClear !== null, "the held Audit clear");
  gatekeeperRecoveryProbe = {
    intentId: "intent-after-clear",
    agent: "Family assistant",
    request: "A newer denied request",
    capabilities: ["Network: allowed"],
    reason: "Newer denial",
  };
  win.webContents.send("gatekeeperRecovery:changed");
  await waitFor(win, `document.querySelector(".gatekeeper-denial-detail")`,
    "the durable historical denial detail while Audit clear is pending");
  globalNotice.concurrentAttentionKeepsHistoricalDetail = true;
  holdAuditClear = false;
  resolveAuditClear();
  resolveAuditClear = null;
  await waitForNode(() => auditCleared, "Audit to finish clearing");
  await waitFor(win, `document.querySelector(".gatekeeper-notice")?.hidden === true`,
    "Clear Log to clear denial attention with the erased activity");
  globalNotice.clearRemovesConcurrentAttention = gatekeeperRecoveryProbe === null;

  // …and the Agents pane with the static-credential fallback EXPANDED. It is the
  // busiest this pane ever gets, and the state whose spacing has to hold: the
  // form must read as the quiet alternative, not the main event.
  await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
  await waitFor(win, `document.querySelector("#view .panel.agents")`, "the Agents pane for static credential setup");
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll("#view button")].find((b) => b.textContent.trim() === "Connect MCP client").click()`,
  );
  await waitFor(win, `document.querySelector(".connect-modal .linkbtn")`, "the MCP setup modal for static credential setup");
  await win.webContents.executeJavaScript(`(() => {
    const link = [...document.querySelectorAll(".connect-modal .linkbtn")].find((b) =>
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
  // Wait for the settled state, not for any `.empty`: the tab now paints an
  // "Opening the vault…" row in that same slot before it reads, so waiting on
  // the node would snapshot the placeholder and fail every assertion below.
  await waitFor(win, `document.body.innerText.includes("can't unlock its vault")`, "the vault pane to settle on locked");
  const vaultLocked = await win.webContents.executeJavaScript(`(${() => {
    const text = document.body.innerText;
    return {
      saysCannotUnlock: text.includes("can't unlock its vault"),
      doesNotClaimEmpty: !text.includes("has not started yet") && !text.includes("isn't available"),
      explains: text.includes("The vault's key can't be opened"),
      // `undecryptable` covers a Keychain key that is gone AND a damaged file.
      // The copy must not pick one and state it as fact.
      hedgesTheCause: text.includes("Usually the key") && text.includes("damaged"),
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
    await win.webContents.executeJavaScript(`(() => { window.__domoSelectTab("audit"); return true; })()`);
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
    await leaveTab("audit");
    await waitAsking();
    const dirtyBlocksTabSwitch =
      (await asking()) && (await js(() => document.querySelector("#seg button.active")?.dataset.tab === "vault"));
    await click(DISCARD);
    await waitFor(win, `document.querySelector("#seg button.active")?.dataset.tab === "audit"`, "the tab to switch");
    const discardAllowsTabSwitch = await js(() => document.querySelector("#seg button.active")?.dataset.tab === "audit");

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
    win.webContents.send("ui:confirmLeave", false);
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
    win.webContents.send("ui:confirmLeave", false);
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
    await leaveTab("audit");
    await waitAsking();
    const editedStillAsks = await asking();
    await click(KEEP);
    await waitAnswered();

    // Back to the original: nothing to save, so nothing is asked.
    await type(BOX, original);
    await leaveTab("audit");
    const revertedSwitched = await waitFor(win,
      `document.querySelector("#seg button.active")?.dataset.tab === "audit"`,
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
    await leaveTab("audit");
    const revealSwitched = await waitFor(win,
      `document.querySelector("#seg button.active")?.dataset.tab === "audit"`,
      "the tab to switch after only looking").then(() => true).catch(() => false);
    const revealAloneIsClean = revealSwitched && !(await asking());
    // Leave nothing open behind this block: a dialog still up would deadlock
    // the next awaited __domoSelectTab in the sections that follow.
    if (await asking()) { await click(DISCARD); await waitAnswered(); }
    await leaveTab("audit");
    await waitFor(win, `document.querySelector("#seg button.active")?.dataset.tab === "audit"`, "a clean exit from the vault block");

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
    win.webContents.send("ui:confirmLeave", false);
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
    focusBackOnTrigger: (document.activeElement?.textContent ?? "").includes("Connect MCP client"),
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

  // The Plugins tab, as a launch straight into it finds main: no accounts until
  // something asks Plow. Google is connected, so the tab asks and settles on
  // Ready with no requirement — not the reconnect prompt the owner saw.
  probeAccountsLoaded = false;
  const gogRow = `[...document.querySelectorAll(".plugin-row")].find((r) => r.querySelector(".plugin-name span")?.textContent === "Gmail and Google Calendar")`;
  await win.webContents.executeJavaScript(`window.__domoSelectTab && window.__domoSelectTab("plugins")`);
  await waitFor(win, `(${gogRow})?.textContent.includes("Ready")`, "the Plugins tab to find Google connected");
  const plugins = await win.webContents.executeJavaScript(`(${() => {
    const rows = [...document.querySelectorAll(".plugin-row")];
    const gog = rows.find((r) => r.querySelector(".plugin-name span")?.textContent === "Gmail and Google Calendar");
    return {
      names: rows.map((r) => r.querySelector(".plugin-name span")?.textContent),
      cliBadges: rows.every((r) => r.querySelector(".plugin-name .badge")?.textContent.trim() === "CLI"),
      describes: (gog?.querySelector(".cap-sub")?.textContent ?? "").includes("Gmail and Calendar"),
      saysReady: (gog?.textContent ?? "").includes("Ready"),
      noRequirement: !document.querySelector(".plugin-req"),
      // The switch is on, and it is a real control (the off switch).
      switchesOn: [...document.querySelectorAll(".plugin-row .switch input")].every((b) => b.checked),
    };
  }})()`);
  // With no account connected: the off switch answers with the fresh state, and
  // the row says Off with its requirement withdrawn — the owner's problem again
  // only when they turn it back on, which names the account and offers the fix.
  const connectedAccounts = connectorProbe.google.accounts;
  connectorProbe.google.accounts = [];
  const flipGog = () => win.webContents.executeJavaScript(`(${gogRow}).querySelector(".switch input").click(), true`);
  await flipGog();
  await waitFor(win, `(${gogRow})?.textContent.includes("Off")`, "the disabled plugin");
  const pluginOff = await win.webContents.executeJavaScript(`({
    saysOff: (${gogRow})?.textContent.includes("Off"),
    noRequirements: !document.querySelector(".plugin-req"),
  })`);
  await flipGog();
  await waitFor(win, `document.querySelector(".plugin-req")`, "the unmet account");
  const pluginUnmet = await win.webContents.executeJavaScript(`(() => {
    const req = document.querySelector(".plugin-req");
    return {
      saysNeedsSetup: (${gogRow})?.textContent.includes("Needs setup"),
      namesRequirement: req?.querySelector(".cap-name")?.textContent === "Google account",
      offersTheFix: req?.querySelector("button.btn")?.textContent.trim() === "Connect Google",
    };
  })()`);
  connectorProbe.google.accounts = connectedAccounts;

  // The permission inventory, now a section of Settings: on a Mac whose
  // inventory says Full Disk Access is off, the row names the permission, its
  // dot says so honestly, the line gives the Messages use case, and the one
  // button routes the grant through System Settings (a key into main's table —
  // the renderer never holds the URL). Nothing has been blocked, so no banner.
  await win.webContents.executeJavaScript(`window.__domoSelectTab && window.__domoSelectTab("settings")`);
  await waitFor(win, `document.querySelector(".cap-row")`, "the Permissions section");
  // The accounts arrive on the connector refresh, a beat after the switches.
  await waitFor(win, `document.querySelectorAll(".cap-account-email").length === 2`, "the connected accounts to list");
  const capabilities = await win.webContents.executeJavaScript(`(${() => {
    const rows = [...document.querySelectorAll(".cap-row")];
    const fda = rows.find((r) => r.querySelector(".cap-name")?.textContent === "Full Disk Access");
    return {
      hasFdaRow: !!fda,
      fdaSaysNotGranted: fda?.querySelector(".status-dot")?.getAttribute("title") === "Not granted",
      fdaNamesMessages: (fda?.querySelector(".cap-sub")?.textContent ?? "").includes("Messages"),
      fdaOffersSystemSettings: fda?.querySelector("button.btn")?.textContent.trim() === "Allow in System Settings…",
      // A granted switch is a word, not a button.
      calendarsGranted: rows.some((r) => r.querySelector(".cap-name")?.textContent === "Calendars" && r.querySelector(".cap-granted")),
      noBanner: !document.querySelector(".cap-banner"),
      fdaNoInlineDragTile: !document.querySelector(".fda-drag-tile"),
      // The hand-off into System Settings wears the macOS "…", never the
      // external-link arrow.
      fdaButtonIsHandoff: !fda?.querySelector("button.btn .ext-arrow"),
      // Connected Accounts, in the tab's own row style: the Google row with
      // its "Add another" (a browser hop, so arrowed), then one row per
      // account with the address, the default's pill, and a labelled menu.
      hasConnectedAccounts: document.querySelector("#view").innerText.includes("Connected Accounts"),
      connectorAccounts: [...document.querySelectorAll(".cap-account-email")].map((e) => e.textContent.trim()),
      connectorDefault: document.querySelector(".cap-account-row .cap-default-pill")?.textContent.trim(),
      connectorDefaultOnFirst: !!document.querySelector(".cap-account-row:first-child .cap-default-pill") &&
        !document.querySelector(".cap-account-row:nth-child(2) .cap-default-pill"),
      connectorMenusLabelled: [...document.querySelectorAll(".cap-account-row")].every(
        (r) => r.querySelector("button")?.getAttribute("aria-label") === "Account actions",
      ),
      connectorAddIsArrowed: [...document.querySelectorAll(".cap-row button.btn")].some(
        (b) => b.textContent.trim().startsWith("Add another") && b.querySelector(".ext-arrow"),
      ),
    };
  }})()`);

  // A block by this Mac lands the renderer on the tab its channel names: a
  // switch is in Settings, and a block naming none is on the Audit tab.
  const activeTab = `document.querySelector("#seg button.active")?.dataset.tab`;
  const landing = async (channel) => {
    const before = await win.webContents.executeJavaScript(activeTab);
    win.webContents.send(channel);
    // Waited on as "no longer where it was", never as "where we expect".
    await waitFor(win, `${activeTab} !== ${JSON.stringify(before)}`, `${channel} to land`);
    return win.webContents.executeJavaScript(activeTab);
  };
  // Audit first: the probe is on Settings already, and the wait is for a move.
  const blockLanding = {
    namesNoSwitch: await landing("ui:showAuditBlocked"),
    namesASwitch: await landing("ui:showCapabilities"),
  };

  // The floating grant panel (fdaGrantFlow.ts) comes up through the same
  // sandboxed preload as every other window. Loaded directly — the probe
  // drives windows, not the flow, so no System Settings is involved.
  const panelWin = offscreen();
  await panelWin.loadFile(path.join(dist, "renderer/fdapanel.html"));
  await waitFor(panelWin, `document.querySelector(".fda-panel")`, "the grant panel to render");
  const grantPanel = await panelWin.webContents.executeJavaScript(`(${() => {
    const tile = document.querySelector(".fda-drag-tile");
    return {
      // The drag source, showing the bundle the dragInfo stub named.
      tileDraggable: tile?.getAttribute("draggable") === "true",
      namesBundle: (tile?.innerText ?? "").includes("Plow Latch"),
      // The PermissionFlow-style header instruction, un-granted phrasing (the
      // probe stub says denied), and a close button to bail out with.
      saysWaiting: document.querySelector(".fda-header-text")?.textContent ===
        "Drag Plow Latch to the list above to allow Full Disk Access.",
      hasClose: !!document.querySelector(".fda-close"),
    };
  }})()`);
  panelWin.destroy();

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
    cloudRoster.noCredentialIdentity &&
    cloudRoster.hidesProvider &&
    mcpRoster.namesBoundDevice &&
    mcpRoster.stillNamesKind &&
    mcpRoster.noDeviceUid &&
    cloudRoster.namesKindAndLine &&
    cloudRoster.showsCreated &&
    cloudRoster.hidesLastUsed &&
    cloudRoster.offersMessage &&
    cloudRoster.rowIsDetailTrigger &&
    cloudRoster.offersNewAgent &&
    cloudDetail.title === "Household helper" &&
    cloudDetail.line.includes("LineWillow · +1 415-555-0142") &&
    cloudDetail.status.includes("StatusReady") &&
    cloudDetail.threads.join("|") === "Willow · You · Robin" &&
    cloudDetail.buttons.join("|") === "Close|Message|Change line|Delete agent" &&
    cloudDetail.readOnly &&
    failedCloudDetailButtons.join("|") === "Close|Message|Delete agent" &&
    cloudDeleteConfirm.title === "Delete Household helper?" &&
    cloudDeleteConfirm.copy &&
    cloudDeleteConfirm.buttons.join("|") === "Cancel|Delete agent" &&
    loadingCloudDetail.line.includes("LineNo line") &&
    loadingCloudDetail.threadState === "Loading threads…" &&
    !loadingCloudDetail.offersMessage &&
    unavailableCloudDetail.line.includes("LineNo line") &&
    unavailableCloudDetail.threadState === "Threads couldn't be loaded." &&
    unavailableCloudDetail.hidesRawLineUid &&
    !unavailableCloudDetail.offersMessage &&
    settings.hasAccountGroup &&
    settings.showsThisMac &&
    settings.noEndpointRow &&
    settings.noAccountUid &&
    settings.noPhonePromise &&
    settings.offersNoRelayKeyField &&
    !settings.bodyLeaksKey &&
    settings.hasConnectedAccountsHere &&
    capabilities.hasConnectedAccounts &&
    capabilities.connectorAccounts.join("|") === "owner@probe.test|work@probe.test" &&
    capabilities.connectorDefault === "Default" &&
    capabilities.connectorDefaultOnFirst &&
    capabilities.connectorMenusLabelled &&
    capabilities.connectorAddIsArrowed &&
    capabilities.fdaButtonIsHandoff &&
    settings.noReviewerGroup &&
    settings.noPasswordField &&
    settings.noSuggestionsCheckbox &&
    settings.hasPermissionInventory &&
    settings.paintedBeforeInventory &&
    settings.fdaNoInlineDragTile &&
    capabilities.hasFdaRow &&
    capabilities.fdaSaysNotGranted &&
    capabilities.fdaNamesMessages &&
    capabilities.fdaOffersSystemSettings &&
    capabilities.calendarsGranted &&
    capabilities.noBanner &&
    blockLanding.namesASwitch === "settings" &&
    blockLanding.namesNoSwitch === "audit" &&
    plugins.names.join("|") === "Gmail and Google Calendar" &&
    plugins.cliBadges &&
    plugins.describes &&
    plugins.saysReady &&
    plugins.noRequirement &&
    plugins.switchesOn &&
    pluginOff.saysOff &&
    pluginOff.noRequirements &&
    pluginUnmet.saysNeedsSetup &&
    pluginUnmet.namesRequirement &&
    pluginUnmet.offersTheFix &&
    capabilities.fdaNoInlineDragTile &&
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
    approvalsReviewer.noRulesTab &&
    approvalsReviewer.inAudit &&
    approvalsReviewer.title === "Gatekeeper" &&
    approvalsReviewer.enabled &&
    approvalsReviewer.showsStoredPurpose &&
    approvalsReviewer.purposeExampleHasBoundary &&
    approvalsReviewer.labelled &&
    approvalsReviewer.explainsEnabled &&
    approvalsReviewer.noAdversarialWord &&
    approvalsReviewer.recoveryNamesDenial &&
    approvalsReviewer.recoveryOffersCoaching &&
    approvalsReviewer.noRetryOverride &&
    approvalsReviewer.manualDenialHasNoCoaching &&
    rulesModalView.opens &&
    rulesModalView.empty &&
    rulesModalView.explainsPluginReadPrefix &&
    historicalSuggestionSurvivesNewerDenial &&
    historicalRecovery.visibleWithoutAttention &&
    historicalRecovery.usesActivityId &&
    historicalRecovery.dismissesLocally &&
    historicalRecovery.returnsOnReselect &&
    gatekeeperRecovery.suggestionEditable &&
    gatekeeperRecovery.suggestionGeneralizes &&
    gatekeeperRecovery.notAppliedAutomatically &&
    gatekeeperRecovery.requiresExplicitUse &&
    gatekeeperRecovery.noKeepAction &&
    gatekeeperRecovery.hasDismiss &&
    gatekeeperRecovery.savedAndDismissed &&
    gatekeeperRecovery.savedPurposeWon &&
    purposeRoundTrip.stored &&
    purposeRoundTrip.fieldShowsWhatWasStored &&
    gatekeeperCloseFlush.allowed &&
    gatekeeperCloseFlush.stored &&
    approvalsAsk.fieldVisible &&
    approvalsAsk.explainsAsk &&
    approvalsAsk.explainsDormantPrompt &&
    askWithoutReviewer.noLongerRelevant &&
    globalNotice.neutral &&
    globalNotice.review &&
    globalNotice.dismiss &&
    globalNotice.routed &&
    globalNotice.dismissedWithoutDeletingRow &&
    globalNotice.concurrentAttentionKeepsHistoricalDetail &&
    globalNotice.clearRemovesConcurrentAttention &&
    settings.noApprovalModeGroup &&
    settings.noModeChipsHere &&
    settings.saysNothingAdversarial &&
    main.hasBridge &&
    main.viewChildren > 0 &&
    main.noRulesTab &&
    main.gatekeeperInAudit &&
    approval.showsCapability &&
    approval.buttons.length > 0 &&
    reviewerNote.showsReason &&
    reviewerNote.labelledAsAdvice &&
    reviewerNote.outsideEnforcedBlock &&
    reviewerNote.enforcedBlockUnchanged &&
    reviewerNote.noMarkupInjected &&
    reviewerNote.spinnerCleared &&
    !reviewerNote.leaksCredential &&
    grantPanel.tileDraggable &&
    grantPanel.namesBundle &&
    grantPanel.saysWaiting &&
    grantPanel.hasClose &&
    errors.length === 0;
  console.log(
    "PROBE:" +
      JSON.stringify({ main, settings, capabilities, plugins, pluginOff, pluginUnmet, blockLanding, strandedOnDisk, settingsPane, connect, cloudRoster, mcpRoster, cloudDetail, failedCloudDetailButtons, cloudDeleteConfirm, loadingCloudDetail, unavailableCloudDetail, agentsShot, approvalsReviewer, rulesModalView, approvalsShot, gatekeeperRecovery, gatekeeperRecoveryShot, purposeRoundTrip, gatekeeperCloseFlush, approvalsAsk, askWithoutReviewer, globalNotice, approvalsShotAsk, agentsOpen, modalClosed, vaultLocked, vaultUnsaved, vaultShot, agentsOpenShot, staleSettingsPane, optimisticMode, settingsShot, approval, reviewerNote, grantPanel, consoleErrors: errors, ok }),
  );
  app.exit(ok ? 0 : 1);
}).catch((err) => {
  // Without this, a throw in the probe above — a `waitFor` that times out
  // because the behavior it waits for no longer exists — leaves Electron
  // running with no window and nothing to end it, and CI sits on a live
  // runner until the job's own timeout hours later. A failed check has to
  // read as a failed check.
  console.error("PROBE-FAILED:", err?.stack ?? err);
  console.error("Renderer console:", errors);
  app.exit(1);
});
