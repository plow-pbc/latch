/**
 * Electron main process — the privileged side. It IS the device agent: it runs
 * @domo/device-core in-process (spawning sandbox-exec, holding the identity
 * key, writing the audit log). The renderer is a sandboxed web view that can
 * do nothing but display view models and post decisions back over IPC.
 *
 * Security posture (DESIGN.md §13.2):
 *   - contextIsolation ON, nodeIntegration OFF, sandbox ON in every window
 *   - no remote content is ever loaded (only local files under dist/renderer)
 *   - the approval window renders ONLY from the verified canonical intent's
 *     view model; agent-controlled strings are inserted as textContent, never
 *     HTML, and the enforceable bound shown is the capability set the sandbox
 *     is derived from — not the goal text.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, Tray } from "electron";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Intent } from "@domo/protocol";
import {
  ApprovalStore,
  DeviceAgent,
  GoalsLibrary,
  PolicyDelegate,
} from "@domo/device-core";
import { createDomoMcpServer, DomoMcpServer } from "@domo/mcp-server";
import { RelayClient } from "@domo/relay-client";
import { approvalViewModel, auditActivities } from "./viewModel.js";
import { loadSettings, saveSettings, WindowBounds } from "./settings.js";
import { adversarialReview, agentHistory, REVIEWER_INFO, REVIEWER_MODEL } from "./adversarialAgent.js";

// Set the app name before the app is ready so the macOS app menu, About/Hide/
// Quit items, and dock title read "Domo Desktop" instead of "Electron".
app.setName("Domo Desktop");

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(dirname, "renderer");

const home = process.env.DOMO_HOME ?? path.join(app.getPath("appData"), "Domo");

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let device: DeviceAgent | null = null;
let goals: GoalsLibrary | null = null;
let mcp: DomoMcpServer | null = null;
let approvals: ApprovalStore | null = null;
let relay: RelayClient | null = null;

/**
 * Policy delegate that drives Electron approval windows. Each decision opens a
 * modal window rendering the intent's view model and resolves on the human's
 * click.
 */
class ElectronPolicy implements PolicyDelegate {
  // Operations honor the configurable approval mode (settings.approvalMode).
  // The returned `source` records HOW it was decided, for the audit log.
  // The adversarial-agent features require an Anthropic API key; without one,
  // adversarial mode falls back to Ask and suggestions are skipped.
  async decideIntent(intent: Intent): Promise<{ decision: "allow_once" | "always_allow" | "deny"; source: string }> {
    const settings = loadSettings(home);
    const mode = settings.approvalMode ?? "ask";
    const hasKey = !!(settings.anthropicApiKey ?? "").trim();

    if (mode === "approve") return { decision: "allow_once", source: "approve" };
    if (mode === "deny") return { decision: "deny", source: "policy" };

    const key = (settings.anthropicApiKey ?? "").trim();
    const audit = device?.audit;
    // Run one review, recording its start and outcome onto the intent's audit
    // timeline so the app shows "adversarial agent started" + its verdict
    // between the request and the final decision.
    const review = async () => {
      const history = agentHistory(audit?.entries() ?? [], intent.agentId);
      audit?.record("adversarial_review_started", {
        intentId: intent.intentId,
        agent: intent.agentId,
        model: REVIEWER_MODEL,
      });
      const r = await adversarialReview({ intent, history, apiKey: key });
      audit?.record("adversarial_review_result", {
        intentId: intent.intentId,
        verdict: r.verdict,
        reason: r.reason,
      });
      return r;
    };

    if (mode === "adversarial" && hasKey) {
      const { verdict } = await review();
      if (verdict === "allow") return { decision: "allow_once", source: "adversarial" };
      if (verdict === "deny") return { decision: "deny", source: "adversarial" };
      // "ask" — the agent couldn't decide; hand it to the human (no suggestion).
      const decision = await openApprovalWindow({ kind: "intent", view: approvalViewModel(intent) });
      return { decision, source: "ask" };
    }

    // Ask mode (or adversarial with no key): show the dialog, optionally with a
    // suggestion when both the toggle and a key are present.
    const suggestion =
      settings.showAgentSuggestions && hasKey
        ? review().then((r) =>
            r.verdict === "allow" ? "allow_once" : r.verdict === "deny" ? "deny" : null,
          )
        : null;
    const decision = await openApprovalWindow(
      { kind: "intent", view: approvalViewModel(intent) },
      suggestion,
    );
    return { decision, source: "ask" };
  }
}

type ApprovalRequest = { kind: "intent"; view: ReturnType<typeof approvalViewModel> };

type ApprovalDecision = "allow_once" | "always_allow" | "deny";

/** Serialize approval windows so two prompts never overlap. */
let approvalChain: Promise<unknown> = Promise.resolve();

function openApprovalWindow(
  request: ApprovalRequest,
  // Resolves to the button the adversarial agent suggests, or null for no hint.
  suggestion: Promise<ApprovalDecision | null> | null = null,
): Promise<ApprovalDecision> {
  const run = () =>
    new Promise<ApprovalDecision>((resolve) => {
      const win = new BrowserWindow({
        width: 460,
        height: 560,
        resizable: false,
        fullscreenable: false,
        title: "Domo — Approve",
        webPreferences: {
          preload: path.join(dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      let settled = false;
      const finish = (decision: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        ipcMain.removeHandler("approval:get");
        win.close();
        resolve(decision);
      };
      // The renderer pulls its model (never pushed with executable content).
      // `suggesting` tells it whether an adversarial review is in flight, so it
      // can show an indeterminate "reviewing…" indicator until the hint lands.
      ipcMain.handleOnce("approval:get", async () => ({ ...request, suggesting: !!suggestion }));
      const onDecision = (_e: unknown, id: string, decision: ApprovalDecision) => {
        if (id !== approvalId(request)) return;
        ipcMain.removeListener("approval:decide", onDecision);
        finish(decision);
      };
      ipcMain.on("approval:decide", onDecision);
      // When the adversarial agent responds, tell the window which button to
      // highlight (or that there's no hint) so it can clear the "reviewing…"
      // indicator. Only meaningful while the window is still open and unanswered.
      if (suggestion) {
        void suggestion
          .catch(() => null)
          .then((decision) => {
            if (!settled && !win.isDestroyed()) {
              win.webContents.send("approval:suggestion", { id: approvalId(request), decision });
            }
          });
      }
      // Closing the window without a choice is a denial (fail safe).
      win.on("closed", () => {
        ipcMain.removeListener("approval:decide", onDecision);
        if (!settled) {
          settled = true;
          resolve("deny");
        }
      });
      void win.loadFile(path.join(rendererDir, "approval.html"));
    });
  const result = approvalChain.then(run, run);
  approvalChain = result.catch(() => {});
  return result;
}

function approvalId(request: ApprovalRequest): string {
  return request.view.intentId;
}

function createMainWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    return;
  }
  const bounds = restorableBounds(loadSettings(home).windowBounds);
  mainWindow = new BrowserWindow({
    width: bounds?.width ?? 940,
    height: bounds?.height ?? 620,
    x: bounds?.x,
    y: bounds?.y,
    title: "Domo Desktop",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void mainWindow.loadFile(path.join(rendererDir, "index.html"));
  // Persist size + position so relaunches match. 'resized'/'moved' fire once
  // after the gesture ends, so no debounce is needed.
  const persist = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const b = mainWindow.getBounds();
    const settings = loadSettings(home);
    settings.windowBounds = b;
    saveSettings(home, settings);
  };
  mainWindow.on("resized", persist);
  mainWindow.on("moved", persist);
  mainWindow.on("close", persist);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** Restore saved bounds only if they still land on a connected display, so a
 * window saved on a now-disconnected monitor doesn't open off-screen. */
function restorableBounds(saved: WindowBounds | undefined): WindowBounds | null {
  if (!saved) return null;
  const onScreen = screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    // Require the window's top-left to sit within a display's work area.
    return (
      saved.x >= w.x &&
      saved.y >= w.y &&
      saved.x < w.x + w.width &&
      saved.y < w.y + w.height
    );
  });
  return onScreen ? saved : null;
}

// MARK: IPC for the main window (audit / goals / rules / settings / status)

ipcMain.handle("audit:list", async () => device?.audit.entries() ?? []);
// Group events into logical activities in the main process, so the sandboxed
// renderer receives plain view models (never agent-controlled markup).
ipcMain.handle("audit:activities", async () => auditActivities(device?.audit.entries() ?? []));
// Clear the audit log after a native confirmation (it's a destructive, local
// action). Returns whether the log was actually cleared.
ipcMain.handle("audit:clear", async () => {
  if (!device) return false;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Cancel", "Clear log"],
    defaultId: 0,
    cancelId: 0,
    message: "Clear the audit log?",
    detail: "This permanently deletes all recorded activity on this device. This can't be undone.",
  });
  if (response !== 1) return false;
  device.audit.clear();
  return true;
});
ipcMain.handle("goals:list", async () => goals?.all() ?? []);
ipcMain.handle("goals:add", async (_e, title: string, text: string) => {
  goals?.add({ title, text });
  return goals?.all() ?? [];
});
ipcMain.handle("goals:remove", async (_e, id: string) => {
  goals?.remove(id);
  return goals?.all() ?? [];
});
ipcMain.handle("goals:restoreDefaults", async () => goals?.restoreDefaults() ?? []);
// Approvals still awaiting an answer, so the UI can show what is outstanding
// rather than relying on a window that may have been closed.
ipcMain.handle("approvals:pending", async () => (await approvals?.pending()) ?? []);
ipcMain.handle("rules:list", async () => device?.policy.allRules() ?? []);
ipcMain.handle("rules:remove", async (_e, key: string) => {
  device?.policy.removeRule(key);
  return device?.policy.allRules() ?? [];
});
ipcMain.handle("ui:getTab", async () => loadSettings(home).selectedTab);
ipcMain.handle("ui:setTab", async (_e, tab: string) => {
  const settings = loadSettings(home);
  settings.selectedTab = tab;
  saveSettings(home, settings);
});
// The relay's URL is shown; the CREDENTIAL IS NEVER RETURNED — the renderer
// only learns whether one is set. It is a secret with no reason to leave the
// main process, and putting it in a sandboxed web view's memory is a way for it
// to end up somewhere we did not choose.
ipcMain.handle("settings:getRelay", async () => {
  const settings = loadSettings(home);
  return {
    url: settings.relayUrl ?? "",
    hasCredential: (settings.relayCredential ?? "").trim().length > 0,
    connected,
  };
});
ipcMain.handle("settings:setRelay", async (_e, url: string, credential: string) => {
  const settings = loadSettings(home);
  settings.relayUrl = (url || "").trim();
  // An empty credential field means "leave it alone", so re-saving the URL
  // does not silently wipe a credential the user cannot see to retype.
  const pasted = (credential || "").trim();
  if (pasted.length > 0) settings.relayCredential = pasted;
  saveSettings(home, settings);
  await startRelay();
});
ipcMain.handle("settings:clearRelayCredential", async () => {
  const settings = loadSettings(home);
  settings.relayCredential = "";
  saveSettings(home, settings);
  await startRelay();
});
ipcMain.handle("settings:getApprovalMode", async () => loadSettings(home).approvalMode ?? "ask");
ipcMain.handle("settings:setApprovalMode", async (_e, mode: string) => {
  const allowed = ["approve", "adversarial", "ask", "deny"];
  const settings = loadSettings(home);
  settings.approvalMode = (allowed.includes(mode) ? mode : "ask") as typeof settings.approvalMode;
  saveSettings(home, settings);
});
ipcMain.handle("settings:getShowSuggestions", async () => loadSettings(home).showAgentSuggestions ?? true);
ipcMain.handle("settings:setShowSuggestions", async (_e, on: boolean) => {
  const settings = loadSettings(home);
  settings.showAgentSuggestions = !!on;
  saveSettings(home, settings);
});
ipcMain.handle("settings:getReviewerInfo", async () => REVIEWER_INFO);
ipcMain.handle("settings:getApiKey", async () => loadSettings(home).anthropicApiKey ?? "");
ipcMain.handle("settings:setApiKey", async (_e, key: string) => {
  const settings = loadSettings(home);
  settings.anthropicApiKey = (key || "").trim();
  saveSettings(home, settings);
});
ipcMain.handle("status:get", async () => ({
  deviceId: device?.identity.deviceId ?? "",
  name: device?.identity.name ?? "",
  connected: connected,
}));

let connected = false;

function notifyRenderer(channel: string): void {
  mainWindow?.webContents.send(channel);
}

/**
 * (Re)start the outbound relay connection from saved settings. Stopping first
 * is what makes this safe to call on every settings change.
 */
async function startRelay(): Promise<void> {
  await relay?.stop();
  relay = null;
  connected = false;
  notifyRenderer("status:changed");

  const settings = loadSettings(home);
  const url = (settings.relayUrl ?? "").trim();
  const credential = (settings.relayCredential ?? "").trim();
  if (!url || !credential || !mcp) return;

  const server = mcp;
  relay = new RelayClient({
    url,
    credential,
    serve: (request, auth) => server.fetch(request, auth),
    onStatusChange: (isConnected) => {
      connected = isConnected;
      notifyRenderer("status:changed");
    },
    // RelayClient redacts the credential from everything it emits; this is the
    // only place its diagnostics reach a log at all.
    log: (message) => console.log(`[relay] ${message}`),
  });
  await relay.start();
}

app.whenReady().then(async () => {
  // The dialog answers; the store writes down what was asked before it is
  // asked, so a pending approval is a record on disk rather than only a promise
  // in memory. It also bounds the wait: an approval nobody answers expires and
  // fails closed instead of pending forever.
  approvals = new ApprovalStore(path.join(home, "device/approvals"), new ElectronPolicy());
  device = new DeviceAgent(home, hostName(), approvals);
  goals = new GoalsLibrary(path.join(home, "device/goals.json"));

  // Live-refresh the audit view whenever a new event is recorded.
  device.audit.events.on("change", () => notifyRenderer("audit:changed"));
  mcp = createDomoMcpServer(device);
  await startRelay();

  createMainWindow();
  setupTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("before-quit", () => {
  void relay?.stop();
});

app.on("window-all-closed", () => {
  // Stay resident in the tray — Domo is a menu-bar agent, not a document app.
});

// Block any attempt to navigate to remote content or open external windows —
// the approval surface must never load anything but our local files.
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

function setupTray(): void {
  // A 1x1 transparent placeholder keeps the tray API happy without an asset
  // pipeline; a real template image ships with the packaged app.
  const image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip("Domo");
  const menu = Menu.buildFromTemplate([
    { label: "Open Domo", click: () => createMainWindow() },
    { type: "separator" },
    { label: "Quit Domo", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function hostName(): string {
  try {
    return os.hostname();
  } catch {
    return "Mac";
  }
}
