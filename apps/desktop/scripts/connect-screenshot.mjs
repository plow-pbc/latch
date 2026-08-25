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

const CHAT = { uid: "chat_groceries", label: "+1 (415) 555-0142 · Alex, Sam" };
const ACTIVE_AGENT = {
  agentId: "cag_groceries",
  name: "Household helper",
  chatUid: CHAT.uid,
  chatLabel: CHAT.label,
  provider: "anthropic",
  status: "active",
  failureReason: null,
  createdAt: "2026-08-24T18:00:00.000Z",
};
const CLOUD_OFF = {
  cloudAgents: [],
  cloudAgentsError: null,
  cloudActionError: null,
  cloudChats: [],
  cloudChatsForbidden: false,
  cloudChatsLoaded: false,
  cloudSendTo: null,
  cloudEnabled: false,
  cloudAgentSettings: {},
  cloudSaving: null,
  cloudSaveError: null,
};
const CLOUD_READY = {
  ...CLOUD_OFF,
  cloudEnabled: true,
  cloudChatsLoaded: true,
  cloudSendTo: "+1 (415) 555-0199",
};
let cloudFixture = CLOUD_OFF;

// Nothing is imported or registered at the top level: Electron does not emit
// `ready` until this entry module finishes evaluating, and a top-level await
// makes that a race nobody wants to debug. `setUp` runs inside whenReady.
const DEVICE_SETTINGS = {
  relayCredential: DEVICE_TOKEN,
  accountUid: "u_7Qk2p9",
  mcpUrl: MCP_URL,
  // The Approvals card shares this tab, and its interesting state is the one
  // with a reviewer running and a purpose written for it to read.
  approvalMode: "adversarial",
  agentPurpose: "Help with grocery orders and calendar. Never touch code or SSH keys.",
};

async function setUp() {
  const { ConnectClient } = await import(path.join(dist, "connectClient.js"));
  const { saveSettings, loadSettings } = await import(path.join(dist, "settings.js"));
  // The Agents tab carries the Approvals card too, so this screen now needs the
  // reviewer's state and the purpose statement. Real actions against the same
  // throwaway home, for the reason the connect handlers are real.
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
  ipcMain.handle("connect:get", async () => ({ ...connect.state(), ...cloudFixture }));
  ipcMain.handle("connect:create", async (_e, name) => connect.createCredential(name));
  ipcMain.handle("connect:dismiss", async () => connect.dismissCredential());
  ipcMain.handle("cloud:create", async (_e, chatUid, name) => {
    cloudFixture = {
      ...cloudFixture,
      cloudAgents: [{ ...ACTIVE_AGENT, chatUid, name: name || "Cloud agent", status: "provisioning" }],
      cloudActionError: null,
    };
  });
  ipcMain.handle("cloud:delete", async (_e, agentId) => {
    cloudFixture = { ...cloudFixture, cloudAgents: cloudFixture.cloudAgents.filter((a) => a.agentId !== agentId) };
  });
  ipcMain.handle("cloud:retry", async (_e, agentId) => {
    cloudFixture = {
      ...cloudFixture,
      cloudAgents: cloudFixture.cloudAgents.map((a) => a.agentId === agentId
        ? { ...a, status: "provisioning", failureReason: null }
        : a),
    };
  });
  ipcMain.handle("cloud:apply", async (_e, agentId, settings) => {
    cloudFixture = {
      ...cloudFixture,
      cloudAgentSettings: { ...cloudFixture.cloudAgentSettings, [agentId]: settings },
      cloudSaving: null,
      cloudSaveError: null,
    };
  });
  ipcMain.handle("status:get", async () => ({ deviceId: "dev_example", name: "Example Mac", connected: true }));
  ipcMain.handle("settings:getInference", async () => readInference(home));
  ipcMain.handle("settings:setApprovalMode", async (_e, mode) => setApprovalMode(home, mode));
  // The Approvals card reads this for its suggestions checkbox. A missing
  // handler rejects, and the pane throws before it paints anything.
  ipcMain.handle("settings:getShowSuggestions", async () => true);
  ipcMain.handle("settings:setShowSuggestions", async () => {});
  ipcMain.handle("settings:getAgentPurpose", async () => readAgentPurpose(home));
  ipcMain.handle("settings:setAgentPurpose", async (_e, purpose) => setAgentPurpose(home, purpose));
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
    name: "cloud-roster",
    cloud: {
      ...CLOUD_READY,
      cloudChats: [CHAT],
      cloudAgents: [ACTIVE_AGENT],
    },
    prepare: async () => {},
    expect: ["Cloud agents", "Household helper", CHAT.label, "Anthropic", "Active", "Settings", "Remove"],
  },
  {
    name: "cloud-picker",
    cloud: {
      ...CLOUD_READY,
      cloudChats: [CHAT, { uid: "chat_family", label: "+1 (415) 555-0188 · Family group" }],
    },
    prepare: async (win) => {
      await clickText(win, "Set up cloud agent", 0);
      await waitFor(win, `document.querySelector(".cloud-modal select")`, "the chat picker");
      const options = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".cloud-modal select option")].map((o) => o.textContent.trim())`,
      );
      if (options.join("|") !== `${CHAT.label}|+1 (415) 555-0188 · Family group|New chat…`) {
        throw new Error(`wrong chat options: ${JSON.stringify(options)}`);
      }
    },
    expect: [
      "Set up a cloud agent",
      "Choose the chat where this agent will read and reply",
      CHAT.label,
      "This changes the chat permanently",
      "Removing the agent later will not restore them",
    ],
  },
  {
    name: "cloud-new-chat",
    cloud: {
      ...CLOUD_READY,
      cloudChats: [CHAT, { uid: "chat_family", label: "+1 (415) 555-0188 · Family group" }],
    },
    prepare: async (win) => {
      await clickText(win, "Set up cloud agent", 0);
      await waitFor(win, `document.querySelector(".cloud-modal select")`, "the chat picker");
      await chooseLastChatOption(win);
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-route")`, "the new-chat explainer");
    },
    expect: [
      "Create a new chat",
      "Verify a new Plow number",
      "Number to text: +1 (415) 555-0199",
      "Start a group thread",
      "The chat appears here once someone speaks",
    ],
  },
  {
    name: "cloud-provisioning",
    cloud: {
      ...CLOUD_READY,
      cloudChats: [CHAT],
      cloudAgents: [{ ...ACTIVE_AGENT, status: "provisioning" }],
    },
    prepare: async () => {},
    expect: ["Household helper", "Provisioning…", "Setting up your agent — this takes a minute or two"],
  },
  {
    name: "cloud-failed",
    cloud: {
      ...CLOUD_READY,
      cloudChats: [CHAT],
      cloudAgents: [{ ...ACTIVE_AGENT, status: "failed", failureReason: "The provider could not start this agent." }],
    },
    prepare: async () => {},
    expect: ["Household helper", "Failed", "The provider could not start this agent", "Retry"],
  },
  {
    name: "cloud-settings",
    cloud: {
      ...CLOUD_READY,
      cloudChats: [CHAT],
      cloudAgents: [ACTIVE_AGENT],
      cloudAgentSettings: {
        [ACTIVE_AGENT.agentId]: { relay: true, inference: false, adversarialReview: true },
      },
    },
    prepare: async (win) => {
      await clickCloudRowButton(win, "Settings");
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-setting")`, "the cloud-agent settings panel");
    },
    expect: [
      "Household helper settings",
      "Relay access",
      "May spend inference",
      "Adversarial review",
      "Your agent will restart briefly",
      "without restarting your agent",
      "Apply changes",
    ],
  },
  {
    name: "cloud-settings-updating",
    cloud: {
      ...CLOUD_READY,
      cloudChats: [CHAT],
      cloudAgents: [ACTIVE_AGENT],
      cloudAgentSettings: {
        [ACTIVE_AGENT.agentId]: { relay: true, inference: false, adversarialReview: true },
      },
      cloudSaving: ACTIVE_AGENT.agentId,
    },
    prepare: async (win) => {
      await clickCloudRowButton(win, "Settings");
      await waitFor(win, `[...document.querySelectorAll(".cloud-modal button")].some((b) => b.textContent.trim() === "Updating agent…")`,
        "the updating cloud-agent settings panel");
      const disabled = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".cloud-modal input")].every((input) => input.disabled)`,
      );
      if (!disabled) throw new Error("cloud settings remained editable while updating");
    },
    expect: ["Household helper settings", "Relay access", "May spend inference", "Adversarial review", "Updating agent…"],
  },
  {
    name: "cloud-settings-failed",
    cloud: {
      ...CLOUD_READY,
      cloudChats: [CHAT],
      cloudAgents: [ACTIVE_AGENT],
      cloudAgentSettings: {
        [ACTIVE_AGENT.agentId]: { relay: false, inference: true, adversarialReview: false },
      },
      cloudSaveError: "Plow could not update this agent.",
    },
    prepare: async (win) => {
      await clickCloudRowButton(win, "Settings");
      await waitFor(win, `document.querySelector(".cloud-modal .cloud-save-error:not([hidden])")`,
        "the failed cloud-agent settings panel");
      const state = await win.webContents.executeJavaScript(`(() => {
        const checks = [...document.querySelectorAll(".cloud-modal input[type=checkbox]")];
        return {
          keptAgent: document.querySelector(".cloud-agent-row")?.textContent.includes("Household helper"),
          keptSettings: checks[0]?.checked === false && checks[1]?.checked === true && checks[2]?.checked === false,
          editable: checks.every((input) => !input.disabled),
        };
      })()`);
      if (!state.keptAgent || !state.keptSettings || !state.editable) {
        throw new Error(`failed settings state was not preserved: ${JSON.stringify(state)}`);
      }
    },
    expect: [
      "Household helper settings",
      "Agent settings were not changed",
      "Plow could not update this agent",
      "Apply changes",
    ],
  },
  {
    name: "cloud-chat-error",
    cloud: {
      ...CLOUD_READY,
      cloudAgents: [ACTIVE_AGENT],
      cloudAgentsError: "Couldn't reach Plow.",
      cloudChats: [],
      cloudChatsLoaded: false,
    },
    prepare: async (win) => {
      const correct = await win.webContents.executeJavaScript(`(() => ({
        hasError: document.querySelector(".cloud-error")?.textContent.includes("Couldn't reach Plow"),
        keepsRoster: document.querySelector(".cloud-agent-row")?.textContent.includes("Household helper"),
        noEmptyState: !document.querySelector(".cloud-empty"),
      }))()`);
      if (!correct.hasError || !correct.keepsRoster || !correct.noEmptyState) {
        throw new Error(`wrong failed-chat-list render: ${JSON.stringify(correct)}`);
      }
    },
    expect: ["Cloud agents could not be refreshed", "Couldn't reach Plow", "Household helper", "Active"],
  },
  {
    name: "cloud-empty",
    cloud: {
      ...CLOUD_READY,
    },
    prepare: async (win) => {
      const text = await win.webContents.executeJavaScript(`document.querySelector(".cloud-empty")?.textContent.trim()`);
      const body = await win.webContents.executeJavaScript(`document.querySelector("#view .panel.agents > .item")?.textContent`);
      if (text !== "No agents." || body.includes("+1 (415) 555-0199")) {
        throw new Error(`empty state is not literal: ${JSON.stringify({ text, body })}`);
      }
    },
    expect: ["No agents.", "Set up cloud agent"],
  },
  {
    name: "oauth",
    cloud: CLOUD_OFF,
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
      "Open Claude",
      "Can't use OAuth? Create a static credential",
      // Approvals moved onto this tab with the clients it governs.
      "Approvals",
      "What happens when an agent asks to do something on this Mac.",
      "AI Reviewer decides",
      "What are agents for?",
      // The purpose describes the errand, and an errand widens the job as
      // readily as it narrows it. This line used to pin the opposite promise.
      "it can widen what gets approved as easily as narrow it",
      "Requests that fit may be approved without asking you.",
      // The suggestions toggle, re-homed onto this card from Settings.
      "Let the reviewer suggest an answer when an approval window opens",
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

async function clickCloudRowButton(win, label) {
  const found = await win.webContents.executeJavaScript(`
    (() => {
      const button = [...document.querySelectorAll(".cloud-agent-row button")]
        .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  if (!found) throw new Error(`no cloud-agent row button labelled ${label}`);
}

async function chooseLastChatOption(win) {
  const changed = await win.webContents.executeJavaScript(`(() => {
    const select = document.querySelector(".cloud-modal select");
    if (!select) return false;
    select.selectedIndex = select.options.length - 1;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  if (!changed) throw new Error("no chat picker to drive");
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
      cloudFixture = screen.cloud ?? CLOUD_OFF;
      await win.loadFile(path.join(dist, "renderer/index.html"));
      await waitFor(win, `document.querySelector("#view .panel.agents")`, "the Agents pane");
      if (cloudFixture.cloudEnabled) {
        await waitFor(win, `document.querySelector("#view .cloud-toolbar, #view .cloud-empty, #view .cloud-forbidden, #view .cloud-error, #view .cloud-loading")`, "the cloud-agent group");
      }
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
