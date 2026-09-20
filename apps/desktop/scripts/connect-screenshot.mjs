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
import { app, ipcMain } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clickText, failLoudly, shootScreens, shotWindow, waitFor } from "./screenshot-harness.mjs";
import { capabilitiesView } from "../dist/capabilitiesModel.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");
const outDir = process.env.OUT_DIR ?? "/tmp";

const MCP_URL = "https://api.plow.co/v1/relay/devices/u_7Qk2p9/mcp";
// Both of these are the shape of a real credential and the substance of none.
// The device one is written to a throwaway home; the client one is what the
// fake mint hands back, so the copy-once block has something to show.
const DEVICE_TOKEN = "plow_EXAMPLEdeviceNOTreal_00000";
const CLIENT_TOKEN = "plow_EXAMPLEclientNOTreal_00000";
const CHAT_TITLE = "Willow · You · Robin";
const TRIP_CHAT_TITLE = "+1 628-555-0144 · You";
const CONNECTORS_EMPTY = {
  busy: false,
  message: "",
  noteKind: "error",
  google: { accounts: [], connecting: false },
};
const CONNECTOR_TIMEOUT_NOTE =
  "We couldn't see a new account. If you reconnected one that was already listed, it's done.";
const CONNECTORS_POPULATED = {
  ...CONNECTORS_EMPTY,
  google: {
    connecting: false,
    accounts: [
      { email: "mary@gmail.com", isDefault: true },
      { email: "mary@work.com", isDefault: false },
    ],
  },
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), "connect-shot-"));

const ACTIVE_AGENT = {
  agentId: "cag_groceries",
  name: "Household helper",
  provider: "exe:life",
  line: { uid: "lin_willow", label: "Willow · +1 415-555-0142" },
  canMessage: true,
  threads: [{ uid: "chat_groceries", label: CHAT_TITLE }],
  status: "running",
  failureReason: null,
  createdAt: "2026-08-24T18:00:00.000Z",
};
const PROVISIONING_AGENT = {
  agentId: "cag_trip",
  name: "Trip planner",
  provider: "exe:hermes",
  line: { uid: "lin_trip", label: "+1 628-555-0144" },
  canMessage: true,
  threads: [{ uid: "chat_trip", label: TRIP_CHAT_TITLE }],
  status: "provisioning",
  failureReason: null,
  createdAt: new Date().toISOString(),
};
const NO_LINE_AGENT = {
  ...ACTIVE_AGENT,
  line: null,
  canMessage: false,
  threads: [],
};
const NO_NUMBER_AGENT = {
  ...ACTIVE_AGENT,
  line: { uid: "lin_willow", label: "Willow" },
  canMessage: false,
  threads: [],
};
const ROSTER = [
  {
    id: 301, name: "Claude Code on MacBook Pro", deviceLabel: "this Mac",
    createdAt: "2026-08-12T17:00:00.000Z", lastSeenAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    chatUids: ["*"], chatAccess: "all",
    permissions: { canReadAndReply: true, canSpendInference: true },
  },
  {
    id: 302, name: "Cursor desktop", deviceLabel: "mba",
    createdAt: new Date().toISOString(), lastSeenAt: null,
    chatUids: [], chatAccess: "none",
    permissions: { canReadAndReply: true, canSpendInference: true },
  },
];
const CLOUD_EMPTY = {
  cloudAgents: [],
  cloudProviders: [
    { id: "exe:hermes", name: "Hermes", phrase: "Start Hermes" },
    { id: "exe:life", name: "Life", phrase: "Start Life" },
  ],
  cloudProvidersError: null,
  cloudFreeLines: [],
  cloudAgentsError: null,
  cloudChatsError: null,
  cloudChatsNeedReactivation: false,
  cloudActionError: null,
  cloudChatsLoaded: true,
  cloudLinesLoaded: true,
};
const CLOUD_READY = {
  ...CLOUD_EMPTY,
};
const RULES = [
  {
    ruleKey: "rule-research",
    agentId: "agent-research",
    agentDisplay: "Research assistant",
    capabilities: [
      { kind: "fs.read", paths: ["~/Documents/Atlas"] },
      { kind: "browser", origins: ["arxiv.org"] },
    ],
  },
  {
    ruleKey: "rule-ops",
    agentId: "agent-ops",
    agentDisplay: "Ops helper",
    capabilities: [
      { kind: "tool", tool: "calendar.list" },
      { kind: "fs.read", paths: ["~/Documents/Receipts"] },
    ],
  },
];
let cloudFixture = CLOUD_EMPTY;
let rosterFixture = [];
const cloudRemovals = [];
let connectorsFixture = CONNECTORS_EMPTY;
let gatekeeperRecoveryFixture = null;

// Nothing is imported or registered at the top level: Electron does not emit
// `ready` until this entry module finishes evaluating, and a top-level await
// makes that a race nobody wants to debug. `setUp` runs inside whenReady.
/** This Mac's relay device uid — the segment plow builds its MCP URL from. */
const DEVICE_UID = "dev_screenshot_mac";
const DEVICE_SETTINGS = {
  relayCredential: DEVICE_TOKEN,
  accountUid: "u_7Qk2p9",
  mcpUrl: MCP_URL,
  // The Audit tab's Gatekeeper card uses its interesting state here: the one
  // with a reviewer running and a purpose written for it to read.
  approvalMode: "adversarial",
  agentPurpose: "Help with grocery orders and calendar. Never touch code or SSH keys.",
};

async function setUp() {
  const { ConnectClient } = await import(path.join(dist, "connectClient.js"));
  const { saveSettings, loadSettings } = await import(path.join(dist, "settings.js"));
  // The Audit screenshot carries the Gatekeeper card, so this harness also
  // serves the reviewer's state and purpose statement from the throwaway home.
  const { readAgentPurpose, readInference, setAgentPurpose, setApprovalMode } = await import(
    path.join(dist, "settingsActions.js")
  );

  // A Mac that has been through login: a device credential and an endpoint.
  saveSettings(home, { ...loadSettings(home), ...DEVICE_SETTINGS });

  /** Plow, stood in for — the one call this screen can make. */
  const api = {
    async createMcpClientKey(token, name, relayResourceUid) {
      if (token !== DEVICE_TOKEN) throw new Error("the mint must use the device credential");
      if (relayResourceUid !== DEVICE_UID) throw new Error("the mint must bind to this Mac");
      return { id: 41, token: CLIENT_TOKEN, name };
    },
  };

  const connect = new ConnectClient({
    api, home, isConnected: () => true, deviceUid: () => DEVICE_UID,
  });

  // The main window's IPC surface, as far as this screen reaches. `connect:*`
  // are the real handlers from main.ts, pointed at the same class.
  const state = () => ({ ...connect.state(), roster: rosterFixture, ...cloudFixture });
  ipcMain.handle("connect:get", async () => state());
  ipcMain.handle("cloud:refresh", async () => state());
  ipcMain.handle("cloud:newAgentMessages", async () => true);
  ipcMain.handle("cloud:changeLine", async () => state());
  ipcMain.handle("cloud:openMessages", async () => true);
  ipcMain.handle("connect:create", async (_e, name) => connect.createCredential(name));
  ipcMain.handle("connect:dismiss", async () => connect.dismissCredential());
  ipcMain.handle("roster:remove", async (_e, id) => {
    rosterFixture = rosterFixture.filter((row) => row.id !== id);
    return state();
  });
  ipcMain.handle("cloud:remove", async (_e, agentId) => {
    cloudRemovals.push(agentId);
    cloudFixture = {
      ...cloudFixture,
      cloudAgents: cloudFixture.cloudAgents.filter((agent) => agent.agentId !== agentId),
    };
    return state();
  });
  ipcMain.handle("status:get", async () => ({ deviceId: "dev_example", name: "Example Mac", connected: true }));
  const gatekeeperActivity = {
    id: "activity-gatekeeper-screenshot",
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
    intentId: "intent-gatekeeper-screenshot",
    exitCode: null,
    capabilities: ["Browser: amazon.com"],
    timeline: [{ text: "Denied by Gatekeeper", state: "bad", at: "2026-09-20T19:00:01.000Z" }],
  };
  ipcMain.handle("audit:page", async () => ({ rows: [gatekeeperActivity], total: 1, size: 1 }));
  ipcMain.handle("audit:activity", async (_event, id) => id === gatekeeperActivity.id ? gatekeeperActivity : null);
  ipcMain.handle("audit:clear", async () => false);
  ipcMain.handle("rules:list", async () => RULES);
  ipcMain.handle("gatekeeperRecovery:get", async () => gatekeeperRecoveryFixture);
  ipcMain.handle("gatekeeperRecovery:dismiss", async (_event, intentId) => {
    if (gatekeeperRecoveryFixture?.intentId === intentId) gatekeeperRecoveryFixture = null;
    return gatekeeperRecoveryFixture;
  });
  ipcMain.handle("gatekeeperRecovery:suggest", async () => ({
    ok: true,
    revision: "You are a family assistant authorized to make purchases for birthdays within the owner's stated budget.",
  }));
  ipcMain.handle("rules:remove", async () => {});
  ipcMain.handle("settings:getInference", async () => readInference(home));
  ipcMain.handle("settings:setApprovalMode", async (_e, mode) => setApprovalMode(home, mode));
  ipcMain.handle("settings:getAgentPurpose", async () => readAgentPurpose(home));
  ipcMain.handle("settings:setAgentPurpose", async (_e, purpose) => setAgentPurpose(home, purpose));
  ipcMain.handle("settings:signOut", async () => {});
  ipcMain.handle("settings:getRelay", async () => ({
    accountUid: "u_7Qk2p9",
    mcpUrl: MCP_URL,
    hasCredential: true,
    connected: true,
  }));
  ipcMain.handle("connectors:refresh", async () => connectorsFixture);
  ipcMain.handle("connectors:connect", async () => connectorsFixture);
  ipcMain.handle("connectors:disconnect", async (_e, account) => {
    connectorsFixture = {
      ...connectorsFixture,
      google: {
        connecting: false,
        accounts: connectorsFixture.google.accounts.filter((candidate) => candidate.email !== account),
      },
    };
    return connectorsFixture;
  });
  ipcMain.handle("connectors:setDefault", async (_e, account) => {
    connectorsFixture = {
      ...connectorsFixture,
      google: {
        connecting: false,
        accounts: connectorsFixture.google.accounts.map((candidate) => ({
          ...candidate,
          isDefault: candidate.email === account,
        })),
      },
    };
    return connectorsFixture;
  });
  // Settings' Permissions section, which Connected Accounts now shares: the
  // REAL view model over a stub inventory (Full Disk Access off, nothing
  // blocked).
  const inventory = {
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
  const capabilities = () => ({
    fullDiskAccess: false,
    inventory,
    view: capabilitiesView({ inventory, automation: [], events: [], dismissals: {}, bannerSeenAt: null }),
  });
  ipcMain.handle("capabilities:get", async () => capabilities());
  ipcMain.handle("capabilities:act", async () => capabilities().view);
  ipcMain.handle("capabilities:dismiss", async () => capabilities().view);
  ipcMain.handle("capabilities:bannerSeen", async () => capabilities().view);
  ipcMain.handle("launch:get", async () => ({ supported: false, openAtLogin: false }));
  ipcMain.handle("power:getKeepAwake", async () => ({ enabled: false }));
  ipcMain.handle("telemetry:get", async () => ({ enabled: true }));
  ipcMain.handle("ui:getTab", async () => "agents");
  ipcMain.handle("ui:setTab", async () => {});
  ipcMain.handle("onboarding:open", async () => {});
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

/** Settings, where Connected Accounts lives now, with the connector state
 *  drawn (it arrives a beat after the switches). */
const showSettings = (settled) => async (win) => {
  await win.webContents.executeJavaScript(`window.__domoSelectTab("settings")`);
  await waitFor(win, `[...document.querySelectorAll(".cap-name")].some((n) => n.textContent === "Google")`,
    "the Connected Accounts section of Settings");
  await waitFor(win, settled, "the connector state to draw");
};

/** Each shot: how to get the screen into that state, and what must be on it. */
const SCREENS = [
  {
    name: "capabilities-connected-accounts",
    connectors: CONNECTORS_POPULATED,
    prepare: showSettings(`document.querySelectorAll(".cap-account-email").length === 2`),
    // Each account is a row under Google, the default's pill beside it, and
    // a "•••" menu (Set as Default / Remove Account) rather than inline
    // buttons; "Add another" carries the browser-hop arrow.
    expect: [
      "Connected Accounts", "Google", "mary@gmail.com", "Default",
      "mary@work.com", "Add another",
    ],
    reject: ["Slack", CONNECTOR_TIMEOUT_NOTE, "Set default"],
    expectAriaLabels: ["Account actions"],
  },
  {
    name: "capabilities-connect-connecting",
    connectors: {
      ...CONNECTORS_EMPTY,
      busy: true,
      google: { accounts: [], connecting: true },
    },
    prepare: showSettings(`document.body.innerText.includes("Connecting…")`),
    expect: ["Connected Accounts", "Google", "Connecting…"],
    reject: ["Slack", CONNECTOR_TIMEOUT_NOTE, "Add another"],
  },
  {
    name: "capabilities-connect-timeout",
    connectors: {
      ...CONNECTORS_EMPTY,
      message: CONNECTOR_TIMEOUT_NOTE,
      noteKind: "neutral",
    },
    prepare: showSettings(`!!document.querySelector(".connector-note.neutral")`),
    expect: ["Connected Accounts", "Google", "Connect", CONNECTOR_TIMEOUT_NOTE],
    reject: ["Slack", "Connecting…"],
    // The label plus its ↗ glyph: the button's text, as the harness reads it.
    expectEnabled: "Connect↗",
    expectNeutralNote: CONNECTOR_TIMEOUT_NOTE,
  },
  {
    name: "agents-final",
    roster: ROSTER,
    cloud: {
      ...CLOUD_READY,
      cloudAgents: [PROVISIONING_AGENT, ACTIVE_AGENT],
    },
    prepare: async (win) => {
      const stale = await win.webContents.executeJavaScript(`(() => {
        const cloud = [...document.querySelectorAll(".list-section")]
          .find((section) => section.querySelector("h2")?.textContent.trim() === "Plow Agents");
        const labels = [...cloud.querySelectorAll("button")].map((button) =>
          button.textContent.trim());
        const rows = [...cloud.querySelectorAll(".cloud-agent-row")];
        const names = rows.map((row) => row.querySelector(".entity-name")?.textContent.trim());
        const contexts = rows.map((row) => row.querySelector(".entity-context")?.textContent.trim());
        return {
          messages: labels.filter((label) => label === "Message").length,
          provider: cloud.textContent.includes("Provider"),
          names,
          contexts,
          usedCopy: cloud.textContent.includes("Used just now"),
        };
      })()`);
      if (
        stale.provider || stale.usedCopy || stale.messages !== 2 ||
        stale.names.join("|") !== "Trip planner|Household helper" ||
        !stale.contexts[0]?.includes("Created today") ||
        !stale.contexts[1]?.includes("Created Aug 24")
      ) {
        throw new Error(`cloud roster order or copy is wrong: ${JSON.stringify(stale)}`);
      }
    },
    expect: [
      "Plow Agents", "2 agents", "New agent", "Household helper", "Ready",
      "Life · Willow · +1 415-555-0142", "Created Aug 24", "Trip planner", "Setting up…",
      "Hermes · +1 628-555-0144", "Created today", "Message",
      "Other Agents and Clients", "Claude Code on MacBook Pro", "Cursor desktop",
      // Which Mac each static credential works from — this one, or another by
      // the name Plow gave it.
      "Bound to this Mac", "Bound to mba",
    ],
    reject: ["Other sessions"],
  },
  {
    name: "cloud-detail",
    roster: [],
    cloud: { ...CLOUD_READY, cloudAgents: [ACTIVE_AGENT] },
    prepare: async (win) => {
      await win.webContents.executeJavaScript(
        `document.querySelector(".cloud-agent-row .cloud-agent-open").click()`,
      );
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-detail-threads")`,
        "the line agent detail");
      const controls = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".cloud-modal button")].map((button) => button.textContent.trim())`,
      );
      if (controls.join("|") !== "Close|Message|Change line|Delete agent") {
        throw new Error(`detail exposed unexpected controls: ${controls.join("|")}`);
      }
      const statusSizing = await win.webContents.executeJavaScript(`(() => {
        const badge = document.querySelector(".cloud-modal .cloud-detail-field > .badge");
        return {
          badgeWidth: badge?.getBoundingClientRect().width ?? 0,
          fieldWidth: badge?.parentElement?.getBoundingClientRect().width ?? 0,
        };
      })()`);
      if (statusSizing.badgeWidth >= statusSizing.fieldWidth) {
        throw new Error(`detail status did not shrink-wrap: ${JSON.stringify(statusSizing)}`);
      }
    },
    expect: [
      "Household helper", "Line", "Willow · +1 415-555-0142", "Status", "Ready",
      "Threads", CHAT_TITLE, "Close", "Message", "Change line", "Delete agent",
    ],
  },
  {
    name: "cloud-failed-detail",
    cloud: {
      ...CLOUD_READY,
      cloudAgents: [{
        ...ACTIVE_AGENT,
        status: "failed",
        failureReason: "Set up failed",
      }],
    },
    prepare: async (win) => {
      const rosterHasRetry = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".cloud-agent-row button")]
          .some((button) => button.textContent.trim() === "Retry")`,
      );
      if (rosterHasRetry) throw new Error("a failed agent without a retained provider offered Retry");
      await win.webContents.executeJavaScript(
        `document.querySelector(".cloud-agent-row .cloud-agent-open").click()`,
      );
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-detail-threads")`,
        "the failed agent detail");
      const buttons = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".cloud-modal button")]
          .map((button) => button.textContent.trim())`,
      );
      if (buttons.join("|") !== "Close|Message|Delete agent") {
        throw new Error(`failed agent exposed unexpected controls: ${buttons.join("|")}`);
      }
    },
    expect: ["Household helper", "Failed · Set up failed", "Close", "Message", "Delete agent"],
  },
  {
    name: "cloud-chat-loading-detail",
    cloud: {
      ...CLOUD_READY,
      cloudAgents: [NO_LINE_AGENT],
      cloudChatsLoaded: false,
    },
    prepare: async (win) => {
      await win.webContents.executeJavaScript(
        `document.querySelector(".cloud-agent-row .cloud-agent-open").click()`,
      );
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-detail-threads")`,
        "the loading-thread detail");
    },
    expect: ["Household helper", "No line", "Loading threads…", "Delete agent"],
  },
  {
    name: "cloud-chat-failed-detail",
    cloud: {
      ...CLOUD_READY,
      cloudAgents: [NO_LINE_AGENT],
      cloudChatsError: "The chat list is unavailable.",
      cloudChatsLoaded: false,
    },
    prepare: async (win) => {
      await win.webContents.executeJavaScript(
        `document.querySelector(".cloud-agent-row .cloud-agent-open").click()`,
      );
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-detail-threads")`,
        "the unavailable-thread detail");
      const text = await win.webContents.executeJavaScript(
        `document.querySelector(".cloud-modal").textContent`,
      );
      if (text.includes(ACTIVE_AGENT.line.uid)) {
        throw new Error("detail exposed a raw line uid while chats were unavailable");
      }
    },
    expect: ["Household helper", "No line", "Threads couldn't be loaded", "Delete agent"],
  },
  {
    name: "cloud-delete-confirm",
    cloud: { ...CLOUD_READY, cloudAgents: [ACTIVE_AGENT] },
    prepare: async (win) => {
      await win.webContents.executeJavaScript(
        `document.querySelector(".cloud-agent-row .cloud-agent-open").click()`,
      );
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-detail-threads")`,
        "the line agent detail");
      await clickText(win, "Delete agent", 0);
      await waitFor(win,
        `document.querySelector(".cloud-modal .group-title")?.textContent.startsWith("Delete ")`,
        "the cloud delete confirmation");
    },
    expect: [
      "Delete Household helper?",
      "The agent will stop reading and replying, and your conversations on this line may be removed. To get another agent, use New agent to send a setup text.",
      "Cancel", "Delete agent",
    ],
    after: async (win) => {
      await clickText(win, "Delete agent", 0);
      await waitFor(win, `!document.querySelector(".cloud-modal")`,
        "the cloud delete confirmation to close");
      if (cloudRemovals.at(-1) !== ACTIVE_AGENT.agentId) {
        throw new Error("detail delete did not use cloud:remove with the agent id");
      }
    },
  },
  {
    name: "cloud-no-line-detail",
    cloud: {
      ...CLOUD_READY,
      cloudAgents: [NO_LINE_AGENT],
    },
    prepare: async (win) => {
      await win.webContents.executeJavaScript(
        `document.querySelector(".cloud-agent-row .cloud-agent-open").click()`,
      );
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-detail-threads")`,
        "the no-line agent detail");
      const hasMessage = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".cloud-modal button")]
          .some((button) => button.textContent.trim() === "Message")`,
      );
      if (hasMessage) throw new Error("an unresolved agent offered Message");
    },
    expect: ["Household helper", "No line", "No threads.", "Change line", "Delete agent"],
  },
  {
    name: "cloud-line-without-number",
    cloud: {
      ...CLOUD_READY,
      cloudAgents: [NO_NUMBER_AGENT],
    },
    prepare: async (win) => {
      const rosterHasMessage = await win.webContents.executeJavaScript(
        `document.querySelector(".cloud-agent-row .message-btn") !== null`,
      );
      if (rosterHasMessage) throw new Error("a line without an E.164 number offered roster Message");
      await win.webContents.executeJavaScript(
        `document.querySelector(".cloud-agent-row .cloud-agent-open").click()`,
      );
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-detail-threads")`,
        "the unaddressable line agent detail");
      const detailHasMessage = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".cloud-modal button")]
          .some((button) => button.textContent.trim() === "Message")`,
      );
      if (detailHasMessage) throw new Error("a line without an E.164 number offered detail Message");
    },
    expect: [
      "Household helper", "Willow", "No threads on this line.", "Change line", "Delete agent",
    ],
  },
  {
    name: "cloud-teardown",
    cloud: {
      ...CLOUD_READY,
      cloudAgents: [{ ...ACTIVE_AGENT, status: "teardown" }],
    },
    prepare: async () => {},
    expect: ["Household helper", "Removing…"],
  },
  {
    name: "cloud-chat-forbidden",
    cloud: {
      ...CLOUD_READY,
      cloudAgents: [ACTIVE_AGENT],
      cloudAgentsError: "Method Not Allowed",
      cloudChatsError: "This Mac cannot list chats yet. Try re-activating it, then try again.",
      cloudChatsNeedReactivation: true,
      cloudChatsLoaded: false,
    },
    prepare: async () => {},
    expect: [
      "Chats could not be loaded",
      "This Mac cannot list chats yet. Try re-activating it, then try again.",
      "Agents could not be refreshed",
      "Plow couldn't complete that request. Try again.",
      "Sign out and re-activate",
      "Household helper", "Ready",
    ],
  },
  {
    name: "cloud-empty",
    cloud: CLOUD_READY,
    prepare: async (win) => {
      const hasSetup = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll("button")]
          .some((button) => button.textContent.includes("Set up cloud agent"))`,
      );
      if (hasSetup) throw new Error("removed cloud-agent setup action remains");
    },
    expect: ["New agent", "No agents.", "No other agents or clients.", "Connect MCP client"],
  },
  {
    name: "oauth",
    cloud: CLOUD_EMPTY,
    prepare: async (win) => {
      await clickText(win, "Connect MCP client", 0);
      await waitFor(win, `document.querySelector(".connect-modal .connect")`, "the MCP setup modal");
    },
    expect: [
      "Connect an MCP client",
      "Add this server URL to Claude Code, Codex, Cursor",
      MCP_URL,
      // Signing in is not a step any more, but the reassurance still has to be
      // on screen — it is the reason OAuth is the route.
      "signs in with OAuth the first time it connects",
      "no token to copy, store, or rotate",
      // The shortcut to where the URL gets pasted.
      "Open Claude",
      "Can't use OAuth? Create a static credential",
    ],
  },
  {
    name: "audit-gatekeeper",
    cloud: CLOUD_EMPTY,
    prepare: async (win) => {
      gatekeeperRecoveryFixture = {
        intentId: "intent-gatekeeper-screenshot",
        agent: "Family assistant",
        request: "Buy a $125 Lego set on Amazon",
        capabilities: ["Browser: amazon.com"],
        reason: "Purchases are not covered by the current family-assistant instructions.",
      };
      await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
      await waitFor(win, `document.querySelector("#view .audit-gatekeeper")`, "the Audit Gatekeeper card");
      await waitFor(win, `document.querySelector("#view").innerText.includes("Suggest revised instructions")`, "the denial recovery action");
    },
    expect: [
      "Gatekeeper",
      "Enabled",
      "Requests not already allowed by a rule or the Plow workspace go to the AI Reviewer.",
      "Instructions",
      "View 2 rules",
      "Denied",
      "Revise Gatekeeper’s instructions if requests like this should be allowed.",
      "Suggest revised instructions",
    ],
  },
  {
    name: "audit-gatekeeper-deny",
    cloud: CLOUD_EMPTY,
    prepare: async (win) => {
      gatekeeperRecoveryFixture = null;
      await win.webContents.executeJavaScript(`window.__domoSelectTab("agents")`);
      await win.webContents.executeJavaScript(`window.__domoSelectTab("audit")`);
      await waitFor(win, `document.querySelector("#view .audit-gatekeeper")`, "the Audit Gatekeeper card");
      await win.webContents.executeJavaScript(`document.querySelector(".gatekeeper-mode").click()`);
      await waitFor(win, `[...document.querySelectorAll(".menu-label")].some((node) => node.textContent === "Deny everything")`, "the Gatekeeper mode menu");
      await win.webContents.executeJavaScript(`
        [...document.querySelectorAll(".menu-label")]
          .find((node) => node.textContent === "Deny everything")
          .closest("button")
          .click()
      `);
      await waitFor(
        win,
        `document.querySelector("#view").innerText.includes("Every request is refused.")`,
        "the Deny mode explanation",
      );
    },
    expect: ["Gatekeeper", "Deny everything", "Every request is refused.", "These saved instructions will be used again when Gatekeeper is Enabled."],
  },
  {
    // The form is a MODAL now, not an inline expander — same click, same
    // fields, over the pane instead of inside it.
    name: "static-form",
    prepare: async (win) => {
      await clickText(win, "Connect MCP client", 0);
      await waitFor(win, `document.querySelector(".connect-modal .connect")`, "the MCP setup modal");
      await clickText(win, "Can't use OAuth");
    },
    expect: [
      "Static credential",
      "Name this connection",
      "For a tool that only needs MCP access to this Mac",
      "The token is shown once.",
      "Create Credential",
      "Cancel",
    ],
  },
  {
    name: "static-shown",
    prepare: async (win) => {
      await clickText(win, "Connect MCP client", 0);
      await waitFor(win, `document.querySelector(".connect-modal .connect")`, "the MCP setup modal");
      await clickText(win, "Can't use OAuth");
      // No line picker: this credential is a tool's key, not an agent, and a
      // name is the whole form. Asserted here rather than only in `expect`,
      // which reads text and would not see a select that renders empty.
      const noLinePicker = await win.webContents.executeJavaScript(
        `!document.querySelector('.modal select[aria-label="Line"]')`,
      );
      if (!noLinePicker) throw new Error("the static form still asks for a line");
      await type(win, `input[placeholder="Claude Code"]`, "Claude Code");
      const enabled = await win.webContents.executeJavaScript(`(() => {
        const button = [...document.querySelectorAll(".modal button")]
          .find((node) => node.textContent === "Create Credential");
        return button?.disabled === false;
      })()`);
      if (!enabled) throw new Error("static creation blocked with a name given");
      await clickText(win, "Create Credential");
      console.log("STATIC-NAME: no line picker; a named form mints on the first click");
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

async function clickElementText(win, selector, label) {
  const point = await win.webContents.executeJavaScript(`(() => {
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  if (!point) throw new Error(`no ${selector} labelled ${label}`);
  win.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
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

failLoudly();

app.whenReady().then(async () => {
  const connect = await setUp();
  const win = shotWindow(dist);

  // Copy-once is a claim about the app, so the run checks it rather than
  // leaving it to the picture: once dismissed, the config is gone for good.
  const extra = [];
  SCREENS.find((s) => s.name === "static-shown").after = async () => {
    connect.dismissCredential();
    if (JSON.stringify(connect.state()).includes(CLIENT_TOKEN)) {
      extra.push("copy-once");
      console.log("SHOT:" + JSON.stringify({ screen: "copy-once", missing: ["credential survived dismissal"] }));
    }
  };

  const failures = await shootScreens({
    win,
    outDir,
    prefix: "connect",
    screens: SCREENS,
    // A reload re-runs the renderer's boot, which restores the Agents tab — and
    // drops any modal left standing by the screen before it.
    load: async (screen) => {
      cloudFixture = screen.cloud ?? CLOUD_EMPTY;
      rosterFixture = screen.roster ?? [];
      connectorsFixture = screen.connectors ?? CONNECTORS_EMPTY;
      await win.loadFile(path.join(dist, "renderer/index.html"));
      await waitFor(win, `document.querySelector("#view .panel.agents")`, "the Agents pane");
      await waitFor(win, `document.querySelector("#view .agents-roster .list-section")`, "the Agents inventory");
    },
    beforeShot: async (w, screen) => {
      if (screen.scrollToBottom) {
        // The credential and its button can sit below the fold in a 620pt window,
        // and the modal scrolls itself — so that is what gets scrolled when it is up.
        await w.webContents.executeJavaScript(
          `(() => { const p = document.querySelector(".modal") ?? document.querySelector(".panel"); if (p) p.scrollTop = p.scrollHeight; })()`,
        );
      }
      // DOM state can be ready one frame before Chromium has painted it. The
      // screenshot is visual evidence, so wait for paint rather than capturing
      // the previous screen with the new screen's text assertions.
      await w.webContents.executeJavaScript(
        `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
      );
    },
  });

  fs.rmSync(home, { recursive: true, force: true });
  rosterFixture = ROSTER;
  const id = ROSTER[0].id;
  const renameExposed = await win.webContents.executeJavaScript(`
    typeof window.domo.rosterRename !== "undefined" ||
    [...document.querySelectorAll(".more-menu button")].some((node) => node.textContent === "Rename")
  `);
  if (renameExposed) throw new Error("unsupported session rename remains exposed");
  const removed = await win.webContents.executeJavaScript(`window.domo.rosterRemove(${id})`);
  if (removed.roster.some((row) => row.id === id)) throw new Error("roster remove retained the MCP client");
  console.log("ROSTER-EDIT: unsupported rename absent; remove passed");
  app.exit(failures + extra.length === 0 ? 0 : 1);
});
