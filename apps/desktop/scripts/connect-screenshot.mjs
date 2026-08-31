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
// The REAL encoder, not a second spelling of `targetId + NUL + agentId`.
import { rowKey } from "../dist/cloudAgentMapper.js";
import { BUILTIN_TARGET_ID } from "../dist/plowApi.js";

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
const CHAT_TITLE = "Willow · You · Robin";
const TRIP_CHAT_TITLE = "+1 628-555-0144 · You";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "connect-shot-"));

const ACTIVE_AGENT = {
  rowKey: rowKey(BUILTIN_TARGET_ID, "cag_groceries"),
  agentId: "cag_groceries",
  name: "Household helper",
  line: { uid: "lin_willow", label: "Willow · +1 415-555-0142" },
  canMessage: true,
  canRetry: true,
  threads: [{ uid: "chat_groceries", label: CHAT_TITLE }],
  status: "running",
  failureReason: null,
  createdAt: "2026-08-24T18:00:00.000Z",
};
const PROVISIONING_AGENT = {
  rowKey: rowKey(BUILTIN_TARGET_ID, "cag_trip"),
  agentId: "cag_trip",
  name: "Trip planner",
  line: { uid: "lin_trip", label: "+1 628-555-0144" },
  canMessage: true,
  canRetry: true,
  threads: [{ uid: "chat_trip", label: TRIP_CHAT_TITLE }],
  status: "provisioning",
  failureReason: null,
  createdAt: new Date().toISOString(),
};
const NO_LINE_AGENT = {
  ...ACTIVE_AGENT,
  line: null,
  canMessage: false,
  canRetry: false,
  threads: [],
};
const NO_NUMBER_AGENT = {
  ...ACTIVE_AGENT,
  line: { uid: "lin_willow", label: "Willow" },
  canMessage: false,
  threads: [],
};
const EMPTY_ROSTER = { cloud: [], mcp: [], other: [], revokedHidden: 0 };
const ROSTER = {
  cloud: [
    {
      id: 201, name: ACTIVE_AGENT.name, kind: "Agent",
      createdAt: "2026-08-24T18:00:00.000Z", lastSeenAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      rowKey: rowKey(BUILTIN_TARGET_ID, ACTIVE_AGENT.agentId),
      agentId: ACTIVE_AGENT.agentId, chatUids: [], chatAccess: "none",
      permissions: { canReadAndReply: true, canReachMac: true, canSpendInference: true },
      isActive: true, isThisMac: false,
    },
    {
      id: 202, name: PROVISIONING_AGENT.name, kind: "Agent",
      createdAt: new Date().toISOString(), lastSeenAt: null,
      rowKey: rowKey(BUILTIN_TARGET_ID, PROVISIONING_AGENT.agentId),
      agentId: PROVISIONING_AGENT.agentId, chatUids: ["chat_trip"], chatAccess: "listed",
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
      id: 403, name: "Legacy automation token", kind: "Admin — full access",
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
  cloudFreeLines: [],
  cloudLineFlow: {
    phase: "idle",
    activation: null,
    message: null,
    completedRowKey: null,
    retryNewLine: false,
  },
  cloudAgentsError: null,
  cloudChatsError: null,
  cloudChatsNeedReactivation: false,
  cloudActionError: null,
  cloudChatsLoaded: true,
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
let exhaustNextCloudActivation = false;
const cloudRemovals = [];

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
      return {
        id: 700,
        token: CLIENT_TOKEN,
        keyPrefix: CLIENT_TOKEN.slice(5, 13),
        name,
        mcpConfig: JSON.stringify({
          mcpServers: {
            "plow-macbook-pro": {
              type: "http",
              url: MCP_URL,
              headers: { Authorization: `Bearer ${CLIENT_TOKEN}` },
            },
          },
        }),
      };
    },
  };

  const connect = new ConnectClient({ api, home, isConnected: () => true });

  // The main window's IPC surface, as far as this screen reaches. `connect:*`
  // are the real handlers from main.ts, pointed at the same class.
  const state = () => ({ ...connect.state(), roster: rosterFixture, ...cloudFixture });
  ipcMain.handle("connect:get", async () => state());
  ipcMain.handle("cloud:refresh", async () => state());
  ipcMain.handle("cloud:cancelLineFlow", async () => {
    cloudFixture = {
      ...cloudFixture,
      cloudLineFlow: { ...CLOUD_EMPTY.cloudLineFlow },
    };
    return state();
  });
  ipcMain.handle("cloud:create", async (_e, input) => {
    if (input?.lineUid === "lin_error") {
      cloudFixture = {
        ...cloudFixture,
        cloudLineFlow: {
          phase: "error",
          activation: null,
          message: "Plow returned 422.",
          completedRowKey: null,
          retryNewLine: false,
        },
      };
    } else if (input?.lineUid === null && exhaustNextCloudActivation) {
      exhaustNextCloudActivation = false;
      cloudFixture = {
        ...cloudFixture,
        cloudLineFlow: {
          phase: "error",
          activation: null,
          message: "No numbers are available right now. Try again later.",
          completedRowKey: null,
          retryNewLine: false,
          terminal: "no_numbers",
        },
      };
    } else if (input?.lineUid === null) {
      cloudFixture = {
        ...cloudFixture,
        cloudLineFlow: {
          phase: "waiting",
          activation: {
            displayCode: "LINE42",
            sendTo: "+1 555-123-0000",
            smsBody: "Plow Activate: LINE42",
          },
          message: null,
          completedRowKey: null,
          retryNewLine: false,
        },
      };
    } else if (typeof input?.lineUid === "string") {
      const created = {
        rowKey: rowKey(BUILTIN_TARGET_ID, "cag_created"),
        agentId: "cag_created",
        name: input.name || "Cloud agent",
        line: { uid: input.lineUid, label: "Ash · +1 415-555-0199" },
        canMessage: true,
        canRetry: true,
        threads: [],
        status: "provisioning",
        failureReason: null,
        createdAt: new Date().toISOString(),
      };
      cloudFixture = {
        ...cloudFixture,
        cloudAgents: [created, ...cloudFixture.cloudAgents],
        cloudFreeLines: [],
        cloudLineFlow: {
          ...CLOUD_EMPTY.cloudLineFlow,
          completedRowKey: created.rowKey,
        },
      };
    }
    return state();
  });
  ipcMain.handle("cloud:retryLineFlow", async () => state());
  ipcMain.handle("cloud:retryFailed", async () => state());
  ipcMain.handle("cloud:changeLine", async (_e, input) => {
    if (input?.lineUid === null) {
      cloudFixture = {
        ...cloudFixture,
        cloudLineFlow: {
          phase: "waiting",
          activation: {
            displayCode: "MOVE42",
            sendTo: "+1 555-123-0000",
            smsBody: "Plow Activate: MOVE42",
          },
          message: null,
          completedRowKey: null,
          retryNewLine: false,
        },
      };
    } else if (typeof input?.lineUid === "string") {
      cloudFixture = {
        ...cloudFixture,
        cloudAgents: cloudFixture.cloudAgents.map((agent) => agent.rowKey === input.rowKey
          ? {
              ...agent,
              line: { uid: input.lineUid, label: "Ash · +1 415-555-0199" },
              threads: [],
            }
          : agent),
        cloudFreeLines: [],
        cloudLineFlow: {
          ...CLOUD_EMPTY.cloudLineFlow,
          completedRowKey: input.rowKey,
        },
      };
    }
    return state();
  });
  ipcMain.handle("cloud:openMessages", async () => true);
  ipcMain.handle("connect:create", async (_e, name) => connect.createCredential(name));
  ipcMain.handle("connect:dismiss", async () => connect.dismissCredential());
  ipcMain.handle("roster:remove", async (_e, id) => {
    rosterFixture = {
      ...rosterFixture,
      cloud: rosterFixture.cloud.filter((row) => row.id !== id),
      mcp: rosterFixture.mcp.filter((row) => row.id !== id),
      other: rosterFixture.other.filter((row) => row.id !== id),
    };
    return state();
  });
  ipcMain.handle("cloud:remove", async (_e, key) => {
    cloudRemovals.push(key);
    cloudFixture = {
      ...cloudFixture,
      cloudAgents: cloudFixture.cloudAgents.filter((agent) => agent.rowKey !== key),
    };
    return state();
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
      cloudAgents: [PROVISIONING_AGENT, ACTIVE_AGENT],
    },
    prepare: async (win) => {
      const stale = await win.webContents.executeJavaScript(`(() => {
        const cloud = [...document.querySelectorAll(".list-section")]
          .find((section) => section.querySelector("h2")?.textContent.trim() === "Cloud agents");
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
      "Cloud agents", "2 agents", "New agent", "Household helper", "Ready",
      "Willow · +1 415-555-0142", "Created Aug 24", "Trip planner", "Setting up…",
      "+1 628-555-0144", "Created today", "Message",
      "MCP clients", "Claude Code on MacBook Pro", "Cursor desktop",
      "Other sessions", "Plow Latch on this Mac", "This Mac",
      "Plow website · Safari", "Legacy automation token", "Admin *:*", "14 revoked sessions hidden",
    ],
  },
  {
    name: "cloud-create-picker",
    cloud: {
      ...CLOUD_READY,
      cloudFreeLines: [
        { uid: "lin_ash", label: "Ash · +1 415-555-0199" },
        { uid: "lin_trip", label: "+1 628-555-0144" },
      ],
    },
    prepare: async (win) => {
      await clickText(win, "New agent", 0);
      await waitFor(win, `document.querySelector('.cloud-modal select[aria-label="Line"]')`,
        "the New agent picker");
      const initial = await win.webContents.executeJavaScript(`(() => {
        const modal = document.querySelector(".cloud-modal");
        const provider = modal.querySelector('select[aria-label="Agent type"]');
        const line = modal.querySelector('select[aria-label="Line"]');
        const submit = [...modal.querySelectorAll("button")]
          .find((button) => button.textContent.trim() === "Create agent");
        const fields = [...modal.querySelectorAll(".field")];
        provider.value = "exe:life";
        return {
          options: [...provider.options]
            .map((option) => option.textContent.trim() + ":" + option.value),
          lines: [...line.options]
            .map((option) => option.textContent.trim() + ":" + option.value),
          selectedLine: line.value,
          disabled: submit.disabled,
          fieldGaps: fields.slice(1).map((field, index) =>
            Math.round(field.getBoundingClientRect().top -
              fields[index].getBoundingClientRect().bottom)),
          labelGaps: fields.map((field) => Math.round(
            field.querySelector("input, select").getBoundingClientRect().top -
              field.querySelector("label").getBoundingClientRect().bottom,
          )),
        };
      })()`);
      if (
        initial.options.join("|") !== "Hermes:exe:hermes|Life:exe:life|Pirate:exe:pirate" ||
        initial.lines.join("|") !==
          "Choose a line…:|Ash · +1 415-555-0199:lin_ash|+1 628-555-0144:lin_trip|New line:__new_line__" ||
        initial.selectedLine !== "" || !initial.disabled ||
        initial.fieldGaps.join("|") !== "14|14" ||
        !initial.labelGaps.every((gap) => gap === initial.labelGaps[0] && gap >= 4)
      ) {
        throw new Error(`New agent form layout or defaults are wrong: ${JSON.stringify(initial)}`);
      }
    },
    expect: [
      "New agent", "Name (optional)", "Agent type", "Life", "Line",
      "Choose a line…", "Ash · +1 415-555-0199", "+1 628-555-0144",
      "New line", "Cancel", "Create agent",
    ],
  },
  {
    name: "cloud-create-code",
    cloud: {
      ...CLOUD_READY,
      cloudFreeLines: [{ uid: "lin_ash", label: "Ash · +1 415-555-0199" }],
    },
    prepare: async (win) => {
      await clickText(win, "New agent", 0);
      await waitFor(win, `document.querySelector('.cloud-modal select[aria-label="Line"]')`,
        "the New agent picker");
      await win.webContents.executeJavaScript(`(() => {
        const line = document.querySelector('.cloud-modal select[aria-label="Line"]');
        line.value = line.options[line.options.length - 1].value;
        line.dispatchEvent(new Event("change"));
      })()`);
      await clickText(win, "Create agent", 0);
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-activation-code")`,
        "the New line activation code");
    },
    expect: [
      "New line", "Text this code to +1 555-123-0000 from your phone.",
      "LINE42", "Plow Activate: LINE42", "Copy", "Cancel", "Open Messages…",
    ],
  },
  {
    name: "cloud-create-existing-result",
    cloud: {
      ...CLOUD_READY,
      cloudFreeLines: [{ uid: "lin_ash", label: "Ash · +1 415-555-0199" }],
    },
    prepare: async (win) => {
      await clickText(win, "New agent", 0);
      await waitFor(win, `document.querySelector('.cloud-modal select[aria-label="Line"]')`,
        "the existing-line New agent picker");
      await win.webContents.executeJavaScript(`(() => {
        document.querySelector('.cloud-modal input[aria-label="Agent name"]').value = "New helper";
        document.querySelector('.cloud-modal select[aria-label="Agent type"]').value = "exe:pirate";
        const line = document.querySelector('.cloud-modal select[aria-label="Line"]');
        line.value = "lin_ash";
        line.dispatchEvent(new Event("change"));
      })()`);
      await clickText(win, "Create agent", 0);
      await waitFor(win, `!document.querySelector(".cloud-modal")`,
        "the existing-line create modal to close");
    },
    expect: ["Cloud agents", "New helper", "Ash · +1 415-555-0199", "Setting up…", "Created today"],
  },
  {
    name: "cloud-code-confirmed",
    cloud: {
      ...CLOUD_READY,
      cloudFreeLines: [{ uid: "lin_ash", label: "Ash · +1 415-555-0199" }],
    },
    prepare: async (win) => {
      await clickText(win, "New agent", 0);
      await waitFor(win, `document.querySelector('.cloud-modal select[aria-label="Line"]')`,
        "the confirmed-code New agent picker");
      await win.webContents.executeJavaScript(`(() => {
        const line = document.querySelector('.cloud-modal select[aria-label="Line"]');
        line.value = line.options[line.options.length - 1].value;
        line.dispatchEvent(new Event("change"));
      })()`);
      await clickText(win, "Create agent", 0);
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-activation-code")`,
        "the confirmed-code activation screen");
      const created = {
        rowKey: rowKey(BUILTIN_TARGET_ID, "cag_confirmed"),
        agentId: "cag_confirmed",
        name: "Cloud agent",
        line: { uid: "lin_new", label: "+1 415-555-0999" },
        canMessage: true,
        canRetry: true,
        threads: [],
        status: "provisioning",
        failureReason: null,
        createdAt: new Date().toISOString(),
      };
      cloudFixture = {
        ...cloudFixture,
        cloudAgents: [created],
        cloudFreeLines: [],
        cloudLineFlow: {
          ...CLOUD_EMPTY.cloudLineFlow,
          completedRowKey: created.rowKey,
        },
      };
      win.webContents.send("connect:changed");
      await waitFor(win, `document.querySelector(".cloud-modal")?.textContent
        .includes("Code confirmed")`, "the Code confirmed state");
      const buttons = await win.webContents.executeJavaScript(
        `document.querySelectorAll(".cloud-modal button").length`,
      );
      if (buttons !== 0) throw new Error("Code confirmed exposed a manual acknowledgement");
    },
    expect: ["New agent", "Code confirmed", "Setting up your agent…"],
  },
  {
    name: "cloud-no-numbers",
    cloud: { ...CLOUD_READY, cloudFreeLines: [] },
    prepare: async (win) => {
      exhaustNextCloudActivation = true;
      await clickText(win, "New agent", 0);
      await waitFor(win, `document.querySelector('.cloud-modal select[aria-label="Line"]')`,
        "the no-free-lines New agent picker");
      const picker = await win.webContents.executeJavaScript(`(() => {
        const modal = document.querySelector(".cloud-modal");
        const line = modal.querySelector('select[aria-label="Line"]');
        const submit = [...modal.querySelectorAll("button")]
          .find((button) => button.textContent.trim() === "Create agent");
        return {
          options: [...line.options].map((option) => option.textContent.trim()),
          value: line.value,
          enabled: !submit.disabled,
        };
      })()`);
      if (
        picker.options.join("|") !== "Choose a line…|New line" ||
        picker.value !== "" || picker.enabled
      ) {
        throw new Error(`no-free-lines dropdown is wrong: ${JSON.stringify(picker)}`);
      }
      await win.webContents.executeJavaScript(`(() => {
        const line = document.querySelector('.cloud-modal select[aria-label="Line"]');
        line.value = line.options[line.options.length - 1].value;
        line.dispatchEvent(new Event("change"));
      })()`);
      await clickText(win, "Create agent", 0);
      await waitFor(win, `document.querySelector(".cloud-modal")?.textContent
        .includes("No numbers are available right now. Try again later.")`,
        "the no-numbers terminal state");
      const buttons = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".cloud-modal button")]
          .map((button) => button.textContent.trim())`,
      );
      if (buttons.join("|") !== "Close") {
        throw new Error(`no-numbers state exposed retry controls: ${buttons.join("|")}`);
      }
    },
    expect: ["New agent", "No numbers are available right now. Try again later.", "Close"],
  },
  {
    name: "cloud-create-error",
    cloud: {
      ...CLOUD_READY,
      cloudFreeLines: [{ uid: "lin_error", label: "Error line" }],
    },
    prepare: async (win) => {
      await clickText(win, "New agent", 0);
      await waitFor(win, `document.querySelector('.cloud-modal select[aria-label="Line"]')`,
        "the create-error picker");
      await win.webContents.executeJavaScript(`(() => {
        const line = document.querySelector('.cloud-modal select[aria-label="Line"]');
        line.value = "lin_error";
        line.dispatchEvent(new Event("change"));
      })()`);
      await clickText(win, "Create agent", 0);
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-callout-title")?.textContent
        .includes("wasn't created")`, "the create error card");
    },
    expect: [
      "The agent wasn't created", "Plow couldn't complete that request. Try again.",
      "Cancel", "Try again",
    ],
  },
  {
    name: "cloud-lines-unknown",
    cloud: {
      ...CLOUD_READY,
      cloudAgents: [ACTIVE_AGENT],
      cloudFreeLines: [],
      cloudChatsError: "Plow returned 503.",
      cloudChatsLoaded: false,
    },
    prepare: async (win) => {
      await clickText(win, "New agent", 0);
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-callout-title")
        ?.textContent.trim() === "Lines could not be loaded"`, "the unknown-lines picker");
      const buttons = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".cloud-modal button")]
          .map((button) => button.textContent.trim())`,
      );
      if (buttons.join("|") !== "Cancel") {
        throw new Error(`unknown chats exposed a line action: ${buttons.join("|")}`);
      }
    },
    expect: [
      "New agent", "Lines could not be loaded",
      "Plow couldn't complete that request. Try again.", "Cancel",
    ],
  },
  {
    name: "cloud-detail",
    roster: { ...ROSTER, cloud: [ROSTER.cloud[0]], mcp: [], other: [] },
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
        canRetry: false,
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
    name: "cloud-change-line-picker",
    cloud: {
      ...CLOUD_READY,
      cloudAgents: [ACTIVE_AGENT],
      cloudFreeLines: [{ uid: "lin_ash", label: "Ash · +1 415-555-0199" }],
    },
    prepare: async (win) => {
      await win.webContents.executeJavaScript(
        `document.querySelector(".cloud-agent-row .cloud-agent-open").click()`,
      );
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-detail-threads")`,
        "the line agent detail");
      await clickText(win, "Change line", 0);
      await waitFor(win, `document.querySelector('.cloud-modal select[aria-label="Line"]')`,
        "the Change line picker");
      const picker = await win.webContents.executeJavaScript(`(() => {
        const modal = document.querySelector(".cloud-modal");
        const line = modal.querySelector('select[aria-label="Line"]');
        const submit = [...modal.querySelectorAll("button")]
          .find((button) => button.textContent.trim() === "Change line");
        return {
          options: [...line.options]
            .map((option) => option.textContent.trim() + ":" + option.value),
          value: line.value,
          enabled: !submit.disabled,
        };
      })()`);
      if (
        picker.options.join("|") !==
          "Choose a line…:|Ash · +1 415-555-0199:lin_ash|New line:__new_line__" ||
        picker.value !== "" || picker.enabled
      ) {
        throw new Error("Change line dropdown does not expose the expected defaults");
      }
    },
    expect: [
      "Change line", "The agent keeps its name and memory and moves to the new number.",
      "Line", "Choose a line…", "Ash · +1 415-555-0199", "New line", "Cancel", "Change line",
    ],
  },
  {
    name: "cloud-change-line-code",
    cloud: {
      ...CLOUD_READY,
      cloudAgents: [ACTIVE_AGENT],
      cloudFreeLines: [{ uid: "lin_ash", label: "Ash · +1 415-555-0199" }],
    },
    prepare: async (win) => {
      await win.webContents.executeJavaScript(
        `document.querySelector(".cloud-agent-row .cloud-agent-open").click()`,
      );
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-detail-threads")`,
        "the line agent detail");
      await clickText(win, "Change line", 0);
      await waitFor(win, `document.querySelector('.cloud-modal select[aria-label="Line"]')`,
        "the Change line picker");
      await win.webContents.executeJavaScript(`(() => {
        const line = document.querySelector('.cloud-modal select[aria-label="Line"]');
        line.value = line.options[line.options.length - 1].value;
        line.dispatchEvent(new Event("change"));
      })()`);
      await clickText(win, "Change line", 0);
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-activation-code")`,
        "the Change line activation code");
    },
    expect: [
      "New line", "Text this code to +1 555-123-0000 from your phone.",
      "MOVE42", "Plow Activate: MOVE42", "Copy", "Cancel", "Open Messages…",
    ],
  },
  {
    name: "cloud-change-line-result",
    cloud: {
      ...CLOUD_READY,
      cloudAgents: [ACTIVE_AGENT],
      cloudFreeLines: [{ uid: "lin_ash", label: "Ash · +1 415-555-0199" }],
    },
    prepare: async (win) => {
      await win.webContents.executeJavaScript(
        `document.querySelector(".cloud-agent-row .cloud-agent-open").click()`,
      );
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-detail-threads")`,
        "the line agent detail");
      await clickText(win, "Change line", 0);
      await waitFor(win, `document.querySelector('.cloud-modal select[aria-label="Line"]')`,
        "the Change line picker");
      await win.webContents.executeJavaScript(`(() => {
        const line = document.querySelector('.cloud-modal select[aria-label="Line"]');
        line.value = "lin_ash";
        line.dispatchEvent(new Event("change"));
      })()`);
      await clickText(win, "Change line", 0);
      await waitFor(win, `!document.querySelector(".cloud-modal")`,
        "the changed agent roster");
    },
    expect: ["Household helper", "Ash · +1 415-555-0199", "Ready"],
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
    expect: ["Household helper", "Line unavailable", "Loading threads…", "Delete agent"],
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
    expect: ["Household helper", "Line unavailable", "Threads couldn't be loaded", "Delete agent"],
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
      "The agent will stop reading and replying.",
      "Cancel", "Delete agent",
    ],
    after: async (win) => {
      await clickText(win, "Delete agent", 0);
      await waitFor(win, `!document.querySelector(".cloud-modal")`,
        "the cloud delete confirmation to close");
      if (cloudRemovals.at(-1) !== ACTIVE_AGENT.rowKey) {
        throw new Error("detail delete did not use cloud:remove with the agent's row key");
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
    name: "agents-final-revoked-count",
    roster: ROSTER,
    cloud: {
      ...CLOUD_READY,
      cloudAgents: [ACTIVE_AGENT, PROVISIONING_AGENT],
    },
    prepare: async (win) => {
      await win.webContents.executeJavaScript(
        `document.querySelector(".agents-roster").scrollTop =
          document.querySelector(".agents-roster").scrollHeight`,
      );
    },
    expect: ["Other sessions", "14 revoked sessions hidden"],
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
      "Cloud agents could not be refreshed",
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
    expect: ["New agent", "No cloud agents.", "No MCP clients.", "No other sessions.", "Connect MCP client"],
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
