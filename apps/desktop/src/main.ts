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
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compactString, DomoConnection, Intent, jv, parseConnection } from "@domo/protocol";
import {
  PeerTrustEvaluator,
  SPKIPinningEvaluator,
  UnixSocketDialer,
  WebSocketDialer,
} from "@domo/transport";
import {
  DeviceAgent,
  GoalsLibrary,
  PolicyDelegate,
} from "@domo/device-core";
import { approvalViewModel, auditActivities } from "./viewModel.js";
import { LocalBrokerHandle, startLocalBroker } from "./localBroker.js";
import { loadSettings, saveSettings, WindowBounds } from "./settings.js";
import { planAgentLaunch } from "./spawnAgent.js";
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
/** The in-process broker when "local mode" is selected; null in broker mode. */
let localBroker: LocalBrokerHandle | null = null;

/**
 * The domo-mcp shim that wires a Claude session to the broker. In development
 * it's the sibling workspace app; in the packaged app it's the asar-unpacked
 * copy of @domo/app-mcp (unpacked so a plain `node` can execute it).
 */
function resolveShimPath(): string | null {
  const packagedShim = path
    .resolve(dirname, "../node_modules/@domo/app-mcp/dist/main.js")
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const devShim = path.resolve(dirname, "../../mcp/dist/main.js");
  for (const candidate of [packagedShim, devShim]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Policy delegate that drives Electron approval windows. Each decision opens a
 * modal window rendering the verified intent's view model and resolves on the
 * human's click. Access requests reuse the same window with a simpler model.
 */
class ElectronPolicy implements PolicyDelegate {
  // Device pairing/access is ALWAYS asked — the approval mode never applies here.
  async decideAccess(agentId: string, agentDisplay: string, goals: string): Promise<boolean> {
    const decision = await openApprovalWindow({
      kind: "access",
      agentDisplay,
      agentId,
      goals,
    });
    return decision === "allow_once" || decision === "always_allow";
  }

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

type ApprovalRequest =
  | { kind: "access"; agentDisplay: string; agentId: string; goals: string }
  | { kind: "intent"; view: ReturnType<typeof approvalViewModel> };

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
  return request.kind === "intent" ? request.view.intentId : `access:${request.agentId}`;
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
// The Mac-initiated spin-up (DESIGN.md §2): mint a pre-approved agent, write an
// ephemeral MCP config + prompt + launcher, and open Terminal running an
// interactive Claude seeded with the goal. Returns a human status string.
ipcMain.handle("goals:startAgent", async (_e, goalText: string) => startAgent(goalText));

async function startAgent(goalText: string): Promise<{ ok: boolean; message: string }> {
  const goal = goalText.trim();
  if (!goal) return { ok: false, message: "Type or pick a goal first." };
  if (!device) return { ok: false, message: "Not connected to a device yet — check the broker." };

  let spawned;
  try {
    spawned = jv(await device.requestSpawnAgent(goal));
  } catch (error: unknown) {
    return { ok: false, message: `Provisioning failed: ${error instanceof Error ? error.message : error}` };
  }
  const token = spawned.get("token").str;
  const socket = spawned.get("socket").str;
  if (!token || !socket) return { ok: false, message: "Broker returned an incomplete spawn response." };

  const shim = resolveShimPath();
  if (!shim) return { ok: false, message: "The domo-mcp shim is missing from this install." };
  const claude = findClaude();

  const runDir = path.join(home, "run");
  fs.mkdirSync(runDir, { recursive: true });
  const plan = planAgentLaunch({
    goal,
    deviceId: device.identity.deviceId,
    agentToken: token,
    agentSocket: socket,
    // In local mode the agent dials a Unix socket — no TLS, no pin.
    brokerPin: localBroker ? undefined : parseBrokerConnection()?.pin,
    shimPath: shim,
    claudePath: claude ?? "claude",
    runDir,
    stamp: spawned.get("agent_id").str ?? String(Date.now()),
  });

  if (!claude) {
    return {
      ok: false,
      message: "Claude Code CLI not found on PATH. Run this agent elsewhere:\n\n" + plan.oneLiner,
    };
  }

  // Per-session temp files under run/; the launcher removes them on exit.
  fs.writeFileSync(plan.cfgPath, JSON.stringify(plan.config), { mode: 0o600 });
  fs.writeFileSync(plan.promptPath, plan.prompt);
  fs.writeFileSync(plan.cmdPath, plan.script, { mode: 0o700 });

  if (process.env.DOMO_AGENT_DRYRUN) {
    return { ok: true, message: `[dry-run] wrote launcher: ${plan.cmdPath}` };
  }
  try {
    spawn("/usr/bin/open", ["-a", "Terminal", plan.cmdPath], { detached: true }).unref();
  } catch (error: unknown) {
    return { ok: false, message: `Could not open Terminal: ${error instanceof Error ? error.message : error}` };
  }
  return {
    ok: true,
    message:
      "Opened an interactive agent in Terminal.\n" +
      `Goal: ${goal}\n\n` +
      "The goal is pre-filled — press Return in Terminal to start. " +
      "Approval requests appear here in the app.",
  };
}

/** The current broker connection (for the pin), from saved settings. */
function parseBrokerConnection(): DomoConnection | null {
  const cs = loadSettings(home).brokerConnection;
  return cs ? parseConnection(cs) : null;
}

/** Locate the Claude Code CLI via a login shell (matches the Swift probe). */
function findClaude(): string | null {
  try {
    const out = execFileSync("/bin/zsh", ["-lc", "command -v claude"], {
      encoding: "utf8",
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
ipcMain.handle("rules:list", async () => device?.policy.allRules() ?? []);
ipcMain.handle("rules:remove", async (_e, key: string) => {
  device?.policy.removeRule(key);
  return device?.policy.allRules() ?? [];
});
ipcMain.handle("agents:list", async () => device?.knownAgentIds() ?? []);
ipcMain.handle("agents:revoke", async (_e, agentId: string) => {
  device?.revokeAgent(agentId);
  return device?.knownAgentIds() ?? [];
});
ipcMain.handle("ui:getTab", async () => loadSettings(home).selectedTab);
ipcMain.handle("ui:setTab", async (_e, tab: string) => {
  const settings = loadSettings(home);
  settings.selectedTab = tab;
  saveSettings(home, settings);
});
// Broker settings are shown as their decoded parts — a WebSocket URL and an
// optional cert pin — rather than the opaque connection string. Under the hood
// the app still connects via URL+pin (stored as a connection string).
ipcMain.handle("settings:getBroker", async () => {
  const settings = loadSettings(home);
  const conn = parseConnection(settings.brokerConnection || "");
  return {
    url: conn?.url ?? "",
    pin: conn?.pin ?? "",
    authenticate: conn?.authenticate ?? false,
    mode: settings.connectionMode ?? "broker",
  };
});
ipcMain.handle("settings:setBroker", async (_e, urlOrConn: string, pin: string, mode: string) => {
  const text = (urlOrConn || "").trim();
  const pinText = (pin || "").trim();
  const settings = loadSettings(home);
  settings.connectionMode = mode === "local" ? "local" : "broker";
  // Keep the broker connection string updated even when local mode is chosen,
  // so switching back restores the last-entered broker without retyping.
  if (text) {
    // Accept a pasted connection string (domo1.…/domo://) too, decoding it.
    const parsed = parseConnection(text);
    const conn: DomoConnection = parsed
      ? { url: parsed.url, pin: parsed.pin ?? (pinText || undefined), name: "Domo broker", authenticate: parsed.authenticate }
      : { url: text, pin: pinText || undefined, name: "Domo broker", authenticate: false };
    settings.brokerConnection = compactString(conn);
  }
  saveSettings(home, settings);
  await connectDevice();
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

async function connectDevice(): Promise<void> {
  const settings = loadSettings(home);
  if (!device) return;
  device.disconnect();
  const conn: DomoConnection | null = settings.brokerConnection
    ? parseConnection(settings.brokerConnection)
    : null;

  device.onConnected = () => {
    connected = true;
    notifyRenderer("status:changed");
  };
  device.onLinkDown = () => {
    connected = false;
    notifyRenderer("status:changed");
  };

  // Leaving local mode: shut the in-process broker down before dialing out.
  if (settings.connectionMode !== "local" && localBroker) {
    localBroker.stop();
    localBroker = null;
  }

  try {
    if (settings.connectionMode === "local") {
      if (!localBroker) localBroker = await startLocalBroker(home, resolveShimPath());
      await device.connect(new UnixSocketDialer(localBroker.deviceSocket), true, false);
    } else if (conn && (conn.url.startsWith("ws://") || conn.url.startsWith("wss://"))) {
      const trust: PeerTrustEvaluator | null = conn.pin
        ? new SPKIPinningEvaluator([{ sha256Base64: conn.pin }])
        : null;
      await device.connect(new WebSocketDialer(conn.url, trust), true, conn.authenticate);
    } else {
      // Local development: dial the default Unix device socket.
      const socket = conn?.url ?? path.join(home, "run/device.sock");
      await device.connect(new UnixSocketDialer(socket), true, false);
    }
  } catch {
    // reconnect is on; the link will retry.
  }
}

app.whenReady().then(async () => {
  device = new DeviceAgent(home, hostName(), new ElectronPolicy());
  goals = new GoalsLibrary(path.join(home, "device/goals.json"));

  // Live-refresh the audit view whenever a new event is recorded.
  device.audit.events.on("change", () => notifyRenderer("audit:changed"));

  await connectDevice();
  createMainWindow();
  setupTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  // Stay resident in the tray — Domo is a menu-bar agent, not a document app.
});

// Tear down the local broker on quit: close both listeners, drop live
// connections, unlink the socket files. It runs in-process, so nothing can
// outlive the app; connected MCP shims exit on their own when the socket
// closes. (A stale socket after a crash is unlinked on the next start.)
app.on("will-quit", () => {
  device?.disconnect();
  localBroker?.stop();
  localBroker = null;
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
