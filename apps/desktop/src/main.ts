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
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
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
import { PlowApi, relaySocketUrl, resolveApiBaseUrl } from "./plowApi.js";
import { Onboarding } from "./onboarding.js";
import { ConnectClient } from "./connectClient.js";
import { WindowGate } from "./windowGate.js";
import { adversarialReview, agentHistory, REVIEWER_INFO, REVIEWER_MODEL } from "./adversarialAgent.js";

// Set the app name before the app is ready so the macOS app menu, About/Hide/
// Quit items, and dock title read "Domo Desktop" instead of "Electron".
app.setName("Domo Desktop");

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(dirname, "renderer");

const home = process.env.DOMO_HOME ?? path.join(app.getPath("appData"), "Domo");

/**
 * Which Plow this build talks to. Baked in — an unpackaged run is a dev build
 * and points at the local API; anything else points at production. There is no
 * Settings field for it on purpose (a credential is only valid against the
 * environment that minted it), just a developer env-var override.
 */
const apiBaseUrl = resolveApiBaseUrl({ isDevBuild: !app.isPackaged, env: process.env });

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let device: DeviceAgent | null = null;
let goals: GoalsLibrary | null = null;
let mcp: DomoMcpServer | null = null;
let approvals: ApprovalStore | null = null;
let relay: RelayClient | null = null;
let onboarding: Onboarding | null = null;
let connectClient: ConnectClient | null = null;
let onboardingWindow: BrowserWindow | null = null;

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
  //
  // Bound to THIS window rather than to the module global: the gate clears the
  // global before it closes the window on sign-out, and a persist that reads
  // the global would find null there and quietly stop saving bounds.
  const win = mainWindow;
  const persist = () => {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    const settings = loadSettings(home);
    settings.windowBounds = b;
    saveSettings(home, settings);
  };
  mainWindow.on("resized", persist);
  mainWindow.on("moved", persist);
  mainWindow.on("close", persist);
  // Only if it is still the current one: 'closed' can arrive after the gate has
  // already dropped the reference and opened a replacement.
  mainWindow.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
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
// The account this Mac is signed into. The CREDENTIAL IS NEVER RETURNED — the
// renderer only learns whether one is set. It is a secret with no reason to
// leave the main process, and putting it in a sandboxed web view's memory is a
// way for it to end up somewhere we did not choose.
ipcMain.handle("settings:getRelay", async () => {
  const settings = loadSettings(home);
  return {
    apiBaseUrl,
    accountUid: settings.accountUid ?? "",
    mcpUrl: settings.mcpUrl ?? "",
    hasCredential: (settings.relayCredential ?? "").trim().length > 0,
    connected,
  };
});
// Sign out: forget the device credential and drop the socket. The credential
// itself is not revoked — that needs the account's own key list, which this Mac
// deliberately cannot reach.
//
// Signing out reverses the gate: with no credential this Mac cannot do
// anything, so the main window goes away and the setup window comes back.
ipcMain.handle("settings:signOut", async () => {
  const settings = loadSettings(home);
  settings.relayCredential = "";
  settings.accountUid = "";
  settings.mcpUrl = "";
  saveSettings(home, settings);
  await startRelay();
  // The wizard outlives a sign-out, and it last saw itself on "connected".
  // Reset it before the gate reopens it, or the login screen is a stale one.
  onboarding?.signedOut();
  gate.sync();
});
ipcMain.handle("onboarding:open", async () => openOnboardingWindow());

// MARK: IPC for "Connect a client" (main window)
//
// A pure read, like `onboarding:get` and for the same reason: the renderer
// re-reads on every change notification, so a getter that notifies is an
// unbroken re-render loop.
ipcMain.handle("connect:get", async () => connectClient?.state() ?? null);
ipcMain.handle("connect:create", async (_e, name: string) => connectClient?.createCredential(name));
ipcMain.handle("connect:dismiss", async () => connectClient?.dismissCredential());

// MARK: IPC for the first-run setup window

// A pure read. It must NOT publish: the renderer re-reads on every change
// notification, so a getter that notifies is an unbroken re-render loop that
// leaves the window rendered but inert. See the note in onboarding.ts.
ipcMain.handle("onboarding:get", async () => onboarding?.state() ?? null);
ipcMain.handle("onboarding:begin", async () => onboarding?.begin());
ipcMain.handle("onboarding:newCode", async () => onboarding?.newActivationCode());
ipcMain.handle("onboarding:usePhoneCode", async () => onboarding?.usePhoneCode());
ipcMain.handle("onboarding:useActivation", async () => onboarding?.useActivation());
/**
 * Open Messages with the activation text drafted.
 *
 * Main builds and opens the URL: the renderer is sandboxed and has no way to
 * open one, and this keeps the only `openExternal` call in the app pinned to a
 * `sms:` URL the app composed itself rather than anything a page handed it.
 */
ipcMain.handle("onboarding:openMessages", async () => {
  const url = onboarding?.state().activation?.smsUrl;
  if (url) await shell.openExternal(url);
  return onboarding?.messagesOpened();
});
ipcMain.handle("onboarding:requestCode", async (_e, phone: string) => onboarding?.requestCode(phone));
ipcMain.handle("onboarding:resendCode", async () => onboarding?.resendCode());
ipcMain.handle("onboarding:editPhone", async () => onboarding?.editPhone());
ipcMain.handle("onboarding:submitCode", async (_e, code: string) => onboarding?.submitCode(code));
// The last step of the wizard. It does not just close the setup window — it
// hands the user over to the app, which is the whole point of the gate: the
// main window has not existed until now.
ipcMain.handle("onboarding:finish", async () => {
  gate.sync();
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
  if (channel === "status:changed") onboardingWindow?.webContents.send("onboarding:changed");
}

/**
 * The first-run setup window: show a code → the user texts it → connected.
 * While this Mac holds no credential it is the ONLY window there is — see
 * `windowGate.ts`. It is also openable from Settings once signed in.
 */
function openOnboardingWindow(): void {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show();
    onboardingWindow.focus();
    return;
  }
  onboardingWindow = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: false,
    fullscreenable: false,
    title: "Domo — Set Up",
    webPreferences: {
      preload: path.join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const win = onboardingWindow;
  onboardingWindow.on("closed", () => {
    if (onboardingWindow === win) onboardingWindow = null;
    notifyRenderer("status:changed"); // Settings re-reads what changed
    // Closing the gate is quitting. There is no main window behind it and no
    // way to get one without signing in, so staying resident would leave a Mac
    // with a tray icon, no windows and nothing it can do — a dead app that
    // still looks alive. Signed in, this is just a window closing.
    if (!loadSettings(home).relayCredential.trim()) app.quit();
  });
  void onboardingWindow.loadFile(path.join(rendererDir, "onboarding.html"));
}

/**
 * The login gate. Every path that changes whether this Mac holds a credential —
 * launch, the end of the wizard, sign-out — ends in `gate.sync()`, and nothing
 * else decides which window is open.
 */
const gate = new WindowGate({
  hasCredential: () => loadSettings(home).relayCredential.trim().length > 0,
  isMainOpen: () => !!mainWindow && !mainWindow.isDestroyed(),
  isSetupOpen: () => !!onboardingWindow && !onboardingWindow.isDestroyed(),
  openMain: () => createMainWindow(),
  openSetup: () => openOnboardingWindow(),
  // Drop the reference before closing, so `isMainOpen`/`isSetupOpen` answer
  // truthfully straight away: 'closed' is not guaranteed to have fired by the
  // time `close()` returns.
  closeMain: () => {
    const win = mainWindow;
    mainWindow = null;
    if (win && !win.isDestroyed()) win.close();
  },
  closeSetup: () => {
    const win = onboardingWindow;
    onboardingWindow = null;
    if (win && !win.isDestroyed()) win.close();
  },
});

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
  const credential = (settings.relayCredential ?? "").trim();
  if (!credential || !mcp) return;

  const server = mcp;
  relay = new RelayClient({
    // Derived from the build's API base URL: same origin, scheme swapped, the
    // relay path appended. Two URL fields that must agree is a support burden.
    url: relaySocketUrl(apiBaseUrl),
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

  onboarding = new Onboarding({
    api: new PlowApi(apiBaseUrl),
    home,
    startRelay,
    isConnected: () => connected,
    deviceName: `Domo Desktop (${hostName()})`,
    onChange: () => onboardingWindow?.webContents.send("onboarding:changed"),
    // RelayClient's redaction is not in play here, so nothing secret is ever
    // handed to this — see Onboarding's callers of `warn`.
    warn: (message) => console.log(`[onboarding] ${message}`),
  });

  connectClient = new ConnectClient({
    api: new PlowApi(apiBaseUrl),
    home,
    isConnected: () => connected,
    onChange: () => notifyRenderer("connect:changed"),
  });

  setupTray();
  // The gate decides what opens. A Mac with no credential cannot do anything
  // until it has one, so it gets the setup window and nothing else — not the
  // main window with a setup window floating beside it.
  gate.sync();

  app.on("activate", () => {
    // Whichever window is the right one — never the main window on a Mac that
    // is not signed in.
    gate.sync();
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
    // Through the gate, so the tray cannot hand back a main window this Mac is
    // not entitled to.
    { label: "Open Domo", click: () => gate.sync() },
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
