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

const CHAT = {
  uid: "chat_groceries",
  label: "+1 (415) 555-0142, +1 (415) 555-0193, +1 (628) 555-0112",
  recipients: {
    line: "+14155550142",
    members: ["+14155550193", "+16285550112"],
  },
};
const FAMILY_CHAT = {
  uid: "chat_family",
  label: "+1 (415) 555-0188 · Family group",
  recipients: { line: "+14155550188", members: [] },
};
const ACTIVE_AGENT = {
  agentId: "cag_groceries",
  name: "Household helper",
  chatUids: [CHAT.uid, FAMILY_CHAT.uid],
  chatLabels: [CHAT.label, FAMILY_CHAT.label],
  recipients: CHAT.recipients,
  provider: "exe:hermes",
  status: "running",
  failureReason: null,
  createdAt: "2026-08-24T18:00:00.000Z",
};
const PROVISIONING_AGENT = {
  agentId: "cag_trip",
  name: "Trip planner",
  chatUids: ["chat_trip"],
  chatLabels: ["+1 (628) 555-0144, +1 (415) 555-0193"],
  recipients: { line: "+16285550144", members: ["+14155550193"] },
  provider: "exe:life",
  status: "provisioning",
  failureReason: null,
  createdAt: new Date().toISOString(),
};
const EMPTY_ROSTER = { cloud: [], mcp: [], other: [], revokedHidden: 0 };
const ROSTER = {
  cloud: [
    {
      id: 201, name: ACTIVE_AGENT.name, kind: "Agent",
      createdAt: "2026-08-24T18:00:00.000Z", lastSeenAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      agentId: ACTIVE_AGENT.agentId, chatUids: [], chatAccess: "none",
      permissions: { canReadAndReply: true, canReachMac: true, canSpendInference: true },
      isActive: true, isThisMac: false,
    },
    {
      id: 202, name: PROVISIONING_AGENT.name, kind: "Agent",
      createdAt: new Date().toISOString(), lastSeenAt: null,
      agentId: PROVISIONING_AGENT.agentId, chatUids: [...PROVISIONING_AGENT.chatUids], chatAccess: "listed",
      permissions: { canReadAndReply: true, canReachMac: false, canSpendInference: false },
      isActive: true, isThisMac: false,
    },
  ],
  mcp: [
    {
      id: 301, name: "Claude Code on MacBook Pro", kind: "Agent",
      createdAt: "2026-08-12T17:00:00.000Z", lastSeenAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      agentId: null, chatUids: ["*"], chatAccess: "all",
      permissions: { canReadAndReply: true, canReachMac: true, canSpendInference: true },
      isActive: true, isThisMac: false,
    },
    {
      id: 302, name: "Cursor desktop", kind: "Agent",
      createdAt: new Date().toISOString(), lastSeenAt: null,
      agentId: null, chatUids: [], chatAccess: "none",
      permissions: { canReadAndReply: true, canReachMac: true, canSpendInference: true },
      isActive: true, isThisMac: false,
    },
  ],
  other: [
    {
      id: 401, name: "Plow Latch on this Mac", kind: "Session",
      createdAt: "2026-07-28T17:00:00.000Z", lastSeenAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      agentId: null, chatUids: [], chatAccess: "none",
      permissions: { canReadAndReply: false, canReachMac: false, canSpendInference: false },
      isActive: true, isThisMac: true,
    },
    {
      id: 402, name: "Plow website · Safari", kind: "Plow web login",
      createdAt: "2026-08-24T17:00:00.000Z", lastSeenAt: new Date(Date.now() - 12 * 60_000).toISOString(),
      agentId: null, chatUids: [], chatAccess: "none",
      permissions: { canReadAndReply: false, canReachMac: true, canSpendInference: false },
      isActive: true, isThisMac: false,
    },
    {
      id: 403, name: "Legacy automation token", kind: "Legacy — full access",
      createdAt: "2026-08-20T17:00:00.000Z", lastSeenAt: null,
      agentId: null, chatUids: ["*"], chatAccess: "all",
      permissions: { canReadAndReply: true, canReachMac: true, canSpendInference: true },
      isActive: true, isThisMac: false,
    },
  ],
  revokedHidden: 14,
};
const CLOUD_EMPTY = {
  cloudAgents: [],
  cloudAgentsError: null,
  cloudChatsError: null,
  cloudChatsNeedReactivation: false,
  cloudActionError: null,
  cloudChats: [],
  cloudChatsLoaded: true,
  cloudLines: [
    { uid: "lin_1", displayName: "Willow", number: "+14155550142", held: true },
    { uid: "lin_2", displayName: null, number: "+16285550177", held: false },
  ],
  cloudLinesError: null,
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
let rosterFixture = EMPTY_ROSTER;
const rosterRemovals = [];
const cloudRemovals = [];
let resolveExternalOpen = null;
let holdCloudCreate = false;
let releaseCloudCreate = null;
let cloudCreateInFlight = false;

// Nothing is imported or registered at the top level: Electron does not emit
// `ready` until this entry module finishes evaluating, and a top-level await
// makes that a race nobody wants to debug. `setUp` runs inside whenReady.
const DEVICE_SETTINGS = {
  relayCredential: DEVICE_TOKEN,
  accountUid: "u_7Qk2p9",
  mcpUrl: MCP_URL,
  // The Rules tab's Approvals card uses its interesting state here: the one
  // with a reviewer running and a purpose written for it to read.
  approvalMode: "adversarial",
  agentPurpose: "Help with grocery orders and calendar. Never touch code or SSH keys.",
};

async function setUp() {
  const { ConnectClient } = await import(path.join(dist, "connectClient.js"));
  const { saveSettings, loadSettings } = await import(path.join(dist, "settings.js"));
  // The Rules screenshot carries the Approvals card, so this harness also
  // serves the reviewer's state and purpose statement from the throwaway home.
  const { readAgentPurpose, readInference, setAgentPurpose, setApprovalMode } = await import(
    path.join(dist, "settingsActions.js")
  );

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
  const state = () => ({ ...connect.state(), roster: rosterFixture, ...cloudFixture });
  ipcMain.handle("connect:get", async () => state());
  ipcMain.handle("connect:create", async (_e, name) => connect.createCredential(name));
  ipcMain.handle("connect:dismiss", async () => connect.dismissCredential());
  ipcMain.handle("roster:remove", async (_e, id) => {
    rosterRemovals.push(id);
    rosterFixture = {
      ...rosterFixture,
      cloud: rosterFixture.cloud.filter((row) => row.id !== id),
      mcp: rosterFixture.mcp.filter((row) => row.id !== id),
      other: rosterFixture.other.filter((row) => row.id !== id),
    };
    return state();
  });
  ipcMain.handle("cloud:remove", async (_e, agentId) => {
    cloudRemovals.push(agentId);
    return state();
  });
  ipcMain.handle("external:open", async (_e, key, detail) => {
    resolveExternalOpen?.({ key, detail });
    resolveExternalOpen = null;
    return true;
  });
  // The picker opens through this: the real one re-reads Plow first. Answers
  // with the same shape `connect:get` does, from whatever the scenario set.
  ipcMain.handle("cloud:refresh", async () => state());
  ipcMain.handle("cloud:create", async (_e, chatUids, name, provider) => {
    cloudCreateInFlight = true;
    try {
      if (holdCloudCreate) {
        await new Promise((resolve) => { releaseCloudCreate = resolve; });
      }
      cloudFixture = {
        ...cloudFixture,
        cloudAgents: [{
          ...ACTIVE_AGENT,
          chatUids,
          chatLabels: chatUids,
          name: name || "Cloud agent",
          provider,
          status: "provisioning",
        }],
        cloudActionError: null,
      };
    } finally {
      cloudCreateInFlight = false;
    }
  });
  ipcMain.handle("status:get", async () => ({ deviceId: "dev_example", name: "Example Mac", connected: true }));
  ipcMain.handle("rules:list", async () => RULES);
  ipcMain.handle("rules:remove", async () => {});
  ipcMain.handle("settings:getInference", async () => readInference(home));
  ipcMain.handle("settings:setApprovalMode", async (_e, mode) => setApprovalMode(home, mode));
  ipcMain.handle("settings:getAgentPurpose", async () => readAgentPurpose(home));
  ipcMain.handle("settings:setAgentPurpose", async (_e, purpose) => setAgentPurpose(home, purpose));
  ipcMain.handle("settings:signOut", async () => {});
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

/** Each shot: how to get the screen into that state, and what must be on it. */
const SCREENS = [
  {
    name: "agents-final",
    roster: ROSTER,
    cloud: {
      ...CLOUD_READY,
      cloudChats: [CHAT, {
        uid: PROVISIONING_AGENT.chatUids[0],
        label: PROVISIONING_AGENT.chatLabels[0],
        recipients: PROVISIONING_AGENT.recipients,
      }],
      cloudAgents: [ACTIVE_AGENT, PROVISIONING_AGENT],
    },
    prepare: async (win) => {
      const opened = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Message did not use external:open")), 10_000);
        resolveExternalOpen = (request) => {
          clearTimeout(timeout);
          resolve(request);
        };
      });
      const messageState = await win.webContents.executeJavaScript(`(() => {
        const ready = document.querySelector('button[aria-label="Message Household helper"]');
        const provisioning = document.querySelector('button[aria-label="Message Trip planner"]');
        const permissionsFor = (name) => {
          const row = [...document.querySelectorAll(".entity-row")]
            .find((candidate) => candidate.querySelector(".entity-name")?.textContent.trim() === name);
          return [...(row?.querySelectorAll(".entity-perms span") ?? [])]
            .map((item) => item.textContent.trim());
        };
        ready.click();
        return {
          readyEnabled: ready.disabled === false,
          provisioningDisabled: provisioning.disabled === true,
          readyPermissions: [...ready.closest(".cloud-agent-row").querySelectorAll(".entity-perms span")]
            .map((item) => item.textContent.trim()),
          provisioningPermissions: [...provisioning.closest(".cloud-agent-row").querySelectorAll(".entity-perms span")]
            .map((item) => item.textContent.trim()),
          claudePermissions: permissionsFor("Claude Code on MacBook Pro"),
          thisMacPermissions: permissionsFor("Plow Latch on this Mac"),
          webPermissions: permissionsFor("Plow website · Safari"),
          legacyPermissions: permissionsFor("Legacy automation token"),
        };
      })()`);
      const request = await opened;
      if (!messageState.readyEnabled || !messageState.provisioningDisabled) {
        throw new Error("Message availability did not follow the agent status");
      }
      if (messageState.readyPermissions.join("|") !==
          "Reads and replies in no chats|Can reach this Mac|Can spend inference" ||
          messageState.provisioningPermissions.join("|") !== "Will read and reply in 1 chat") {
        throw new Error(`cloud permission copy did not follow grants: ${JSON.stringify(messageState)}`);
      }
      if (messageState.claudePermissions.join("|") !==
          "Reads and replies in all chats|Can reach this Mac|Can spend inference" ||
          messageState.thisMacPermissions.join("|") !==
            "No agent permissions granted.|Revoking signs this Mac out" ||
          messageState.webPermissions.join("|") !==
            "Can reach this Mac|Revoking signs you out of the Plow website" ||
          messageState.legacyPermissions.join("|") !==
            "Reads and replies in all chats|Can reach this Mac|Can spend inference") {
        throw new Error(`session permission copy did not follow grants: ${JSON.stringify(messageState)}`);
      }
      if (request.key !== "cloudAgentMessages" || request.detail !== ACTIVE_AGENT.agentId) {
        throw new Error("Message did not identify the running agent through external:open");
      }
      await clickAria(win, "More actions for Plow website · Safari");
      const hasShow = await win.webContents.executeJavaScript(`!!document.querySelector(".revoked-summary button")`);
      if (hasShow) throw new Error("the count-only revoked summary grew a Show control");
    },
    expect: [
      "Cloud agents", "2 agents", "Household helper", "Ready", "Trip planner", "Setting up…",
      // Every chat the agent serves, home starred and first. The old line named
      // one chat and prefixed it "Agent"; an agent serves a set now.
      `★ ${CHAT.label}`, FAMILY_CHAT.label,
      "Provider Hermes", "Provider Life",
      "Reads and replies in no chats", "Can reach this Mac", "Can spend inference", "Message",
      "MCP clients", "Claude Code on MacBook Pro", "Reads and replies in all chats",
      "Can reach this Mac", "Can spend inference", "Reads and replies in no chats",
      "Other sessions", "Plow Latch on this Mac", "This Mac", "Plow website · Safari",
      "No agent permissions granted.", "Revoking signs you out of the Plow website", "Legacy automation token",
      "14 revoked sessions hidden", "Revoke",
    ],
  },
  {
    name: "cloud-remove-confirm",
    roster: { ...ROSTER, cloud: [ROSTER.cloud[0]], mcp: [], other: [] },
    cloud: { ...CLOUD_READY, cloudChats: [CHAT], cloudAgents: [ACTIVE_AGENT] },
    prepare: async (win) => {
      await clickAria(win, "More actions for Household helper");
      await clickText(win, "Remove", 0);
      await waitFor(win, `document.querySelector(".roster-confirm")`, "the cloud removal confirmation");
    },
    expect: [
      "Remove Household helper?",
      "The agent will stop reading and replying in all its chats. Their previous notification setup cannot be restored.",
      "Remove agent",
    ],
    after: async (win) => {
      const before = rosterRemovals.length;
      await clickText(win, "Remove agent", 0);
      await waitFor(win, `!document.querySelector(".roster-confirm")`, "the removal confirmation to close");
      if (rosterRemovals.length !== before + 1 || rosterRemovals.at(-1) !== 201) {
        throw new Error("cloud-row removal did not use roster:remove with row 201");
      }
    },
  },
  {
    name: "cloud-remove-without-roster",
    cloud: { ...CLOUD_READY, cloudChats: [CHAT], cloudAgents: [ACTIVE_AGENT] },
    prepare: async (win) => {
      const disabled = await win.webContents.executeJavaScript(
        `document.querySelector('button[aria-label="More actions for Household helper"]')?.disabled === true`,
      );
      if (disabled) throw new Error("rowless cloud agent overflow was disabled");
      await clickAria(win, "More actions for Household helper");
      await clickText(win, "Remove", 0);
      await waitFor(win, `document.querySelector(".roster-confirm")`, "the rowless cloud removal confirmation");
    },
    expect: [
      "Remove Household helper?",
      "The agent will stop reading and replying in all its chats. Their previous notification setup cannot be restored.",
      "Remove agent",
    ],
    after: async (win) => {
      const before = cloudRemovals.length;
      await clickText(win, "Remove agent", 0);
      await waitFor(win, `!document.querySelector(".roster-confirm")`, "the rowless removal confirmation to close");
      if (cloudRemovals.length !== before + 1 || cloudRemovals.at(-1) !== ACTIVE_AGENT.agentId) {
        throw new Error("rowless cloud removal did not use cloud:remove with the agent id");
      }
    },
  },
  {
    name: "agents-final-revoked-count",
    roster: ROSTER,
    cloud: {
      ...CLOUD_READY,
      cloudChats: [CHAT, {
        uid: PROVISIONING_AGENT.chatUids[0],
        label: PROVISIONING_AGENT.chatLabels[0],
        recipients: PROVISIONING_AGENT.recipients,
      }],
      cloudAgents: [ACTIVE_AGENT, PROVISIONING_AGENT],
    },
    prepare: async (win) => {
      await win.webContents.executeJavaScript(`document.querySelector(".agents-roster").scrollTop = document.querySelector(".agents-roster").scrollHeight`);
    },
    expect: ["Other sessions", "14 revoked sessions hidden"],
  },
  {
    name: "cloud-picker",
    cloud: {
      ...CLOUD_READY,
      cloudChats: [CHAT, FAMILY_CHAT],
    },
    prepare: async (win) => {
      await clickText(win, "Set up cloud agent", 0);
      await waitFor(win, `document.querySelector(".cloud-modal .chat-list")`, "the chat checklist");
      // With a chat chosen: the star lands on it and the warning counts it.
      await chooseFirstChat(win);
    },
    expect: [
      "Set up a cloud agent",
      "Choose the chats this agent will read and reply in",
      "Provider", "Hermes", "Life",
      CHAT.label,
      "★ Home",
      "This changes 1 chat permanently",
      "Removing the agent later will not restore them",
    ],
  },
  {
    name: "cloud-new-chat",
    cloud: {
      ...CLOUD_READY,
      cloudChats: [CHAT, FAMILY_CHAT],
    },
    prepare: async (win) => {
      await clickText(win, "Set up cloud agent", 0);
      await waitFor(win, `document.querySelector(".cloud-modal .chat-list")`, "the chat checklist");
      await openNewChatExplainer(win);
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-route-numbers")`, "the new-chat explainer");
    },
    expect: [
      "Create a new chat",
      // The whole instruction: a chat is made by texting a Plow number, not by
      // running activation again.
      'Text "new agent" to one of these numbers',
      "reopen this window",
      // Plow's own numbers, named where it names them, and the marker on one
      // the account already has a chat on.
      "Willow",
      "+14155550142",
      "+16285550177",
      "You already have a chat here",
    ],
  },
  {
    name: "cloud-provisioning",
    cloud: {
      ...CLOUD_READY,
      cloudChats: [CHAT],
      cloudAgents: [],
    },
    prepare: async (win) => {
      holdCloudCreate = true;
      await clickText(win, "Set up cloud agent", 0);
      await waitFor(win, `document.querySelector(".cloud-modal .chat-list")`, "the chat checklist");
      await chooseFirstChat(win);
      await type(win, `input[aria-label="Agent name"]`, "Household helper");
      await win.webContents.executeJavaScript(
        `document.querySelector('.cloud-modal select[aria-label="Provider"]').value = "exe:life"`,
      );
      await clickText(win, "Set up agent", 0);
      await waitFor(win, `!document.querySelector(".cloud-modal")`, "the picker to close during create");
      await waitFor(win, `document.querySelector(".cloud-agent-row .cloud-spinner")`, "the pending agent row");
    },
    after: async () => {
      releaseCloudCreate?.();
      while (cloudCreateInFlight) await new Promise((resolve) => setTimeout(resolve, 10));
      holdCloudCreate = false;
      releaseCloudCreate = null;
    },
    expect: ["Household helper", "Provider Life", "Setting up…", "No granted permissions known."],
  },
  {
    name: "cloud-teardown",
    cloud: {
      ...CLOUD_READY,
      cloudChats: [CHAT],
      cloudAgents: [{ ...ACTIVE_AGENT, status: "teardown" }],
    },
    prepare: async () => {},
    expect: ["Household helper", "Removing…"],
  },
  {
    name: "cloud-chat-forbidden",
    cloud: {
      ...CLOUD_READY,
      cloudAgents: [{
        ...ACTIVE_AGENT,
        recipients: { line: null, members: CHAT.recipients.members },
      }],
      cloudAgentsError: "Method Not Allowed",
      cloudChatsError: "This Mac cannot list chats yet. Try re-activating it, then try again.",
      cloudChatsNeedReactivation: true,
      cloudChats: [{ ...CHAT, recipients: null }],
      cloudChatsLoaded: false,
    },
    prepare: async (win) => {
      const disabled = await win.webContents.executeJavaScript(
        `document.querySelector('button[aria-label="Message Household helper"]')?.disabled === true`,
      );
      if (!disabled) throw new Error("Message remained enabled without structured recipients");
    },
    expect: [
      "Chats could not be loaded",
      "This Mac cannot list chats yet. Try re-activating it, then try again.",
      "Cloud agents could not be refreshed",
      "Plow couldn't complete that request. Try again.",
      "Sign out and re-activate",
      "Household helper",
      "Ready",
      "No granted permissions known.",
    ],
  },
  {
    name: "cloud-chat-fallback-picker",
    cloud: {
      ...CLOUD_READY,
      cloudAgents: [{ ...ACTIVE_AGENT, recipients: null }],
      cloudChatsError: "This Mac cannot list chats yet. Try re-activating it, then try again.",
      cloudChatsNeedReactivation: true,
      cloudChats: [{ ...CHAT, recipients: null }],
      cloudChatsLoaded: false,
    },
    prepare: async (win) => {
      await clickText(win, "Set up cloud agent", 0);
      await waitFor(win, `document.querySelector(".cloud-modal .chat-list")`, "the fallback chat checklist");
    },
    expect: ["Set up a cloud agent", CHAT.label, "Set up agent"],
  },
  {
    name: "cloud-empty",
    cloud: {
      ...CLOUD_READY,
    },
    prepare: async () => {},
    expect: ["No cloud agents.", "No MCP clients.", "No other sessions.", "Set up cloud agent", "Connect MCP client"],
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
    name: "rules-approvals",
    cloud: CLOUD_EMPTY,
    prepare: async (win) => {
      await win.webContents.executeJavaScript(`window.__domoSelectTab("rules")`);
      await waitFor(win, `document.querySelector("#view .panel.rules")`, "the Rules pane");
    },
    expect: [
      "Approvals",
      "What happens when an agent asks to do something on this Mac.",
      "AI Reviewer and Deny still apply to every request",
      "The reviewer sees which agent is asking, what it's asking to do, the exact bounds it would get, and the purpose you wrote for it.",
      "It never sees your files, your history on this Mac, or anything the agent hasn't asked for.",
      "AI Reviewer decides",
      "What are agents for?",
      // The purpose describes the errand, and an errand widens the job as
      // readily as it narrows it. This line used to pin the opposite promise.
      "it can widen what gets approved as easily as narrow it",
      "Requests that fit may be approved without asking you.",
      "Always-allow rules",
      "Research assistant",
      "Ops helper",
      "Revoke Rule",
    ],
  },
  {
    name: "rules-deny",
    cloud: CLOUD_EMPTY,
    prepare: async (win) => {
      await win.webContents.executeJavaScript(`window.__domoSelectTab("rules")`);
      await waitFor(win, `document.querySelector("#view .panel.rules")`, "the Rules pane");
      await clickElementText(win, ".chip", "Deny everything");
      await waitFor(
        win,
        `document.querySelector("#view").innerText.includes("Every request is refused without asking you.")`,
        "the Deny mode explanation",
      );
    },
    expect: ["Approvals", "Deny everything", "Every request is refused without asking you."],
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
    expect: ["Static credential", "Name this connection", "Create Credential", "Cancel"],
  },
  {
    name: "static-shown",
    prepare: async (win) => {
      await clickText(win, "Connect MCP client", 0);
      await waitFor(win, `document.querySelector(".connect-modal .connect")`, "the MCP setup modal");
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

async function clickAria(win, label) {
  const found = await win.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector(` + JSON.stringify(`button[aria-label="${label}"]`) + `);
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  if (!found) throw new Error(`no button labelled ${label}`);
}

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

/** "New chat…" is a link under the checklist, not an entry inside it. */
async function openNewChatExplainer(win) {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const link = [...document.querySelectorAll(".cloud-modal button")]
      .find((button) => button.textContent.trim() === "New chat…");
    if (!link) return false;
    link.click();
    return true;
  })()`);
  if (!clicked) throw new Error("no new-chat link to drive");
}

/** Check the first chat in the checklist — it becomes home by doing so. */
async function chooseFirstChat(win) {
  const checked = await win.webContents.executeJavaScript(`(() => {
    const box = document.querySelector(".cloud-modal .chat-option input");
    if (!box) return false;
    box.click();
    return true;
  })()`);
  if (!checked) throw new Error("no chat checklist to drive");
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
      rosterFixture = screen.roster ?? EMPTY_ROSTER;
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
  app.exit(failures + extra.length === 0 ? 0 : 1);
});
