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
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, systemPreferences, Tray } from "electron";
import electronUpdater from "electron-updater";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Intent } from "@domo/protocol";
import {
  ApprovalStore,
  DeviceAgent,
  PolicyDelegate,
  readCredentialsState,
  resolveBrowserRuntime,
  VaultItemInput,
} from "@domo/device-core";
import { createDomoMcpServer, DomoMcpServer } from "@domo/mcp-server";
import { RelayClient } from "@domo/relay-client";
import { approvalViewModel, auditActivities, CredentialTitles } from "./viewModel.js";
import { probeFullDiskAccess } from "./fullDiskAccess.js";
import { launchAtLoginState, LoginItemApi, setLaunchAtLogin } from "./loginItem.js";
import { devIconScript } from "./devIcon.js";
import { migrateLegacyHome } from "./migrateHome.js";
import { resolveInstancePaths } from "./paths.js";
import { loadSettings, saveSettings, WindowBounds } from "./settings.js";
import { PlowApi, relaySocketUrl, resolveApiBaseUrl } from "./plowApi.js";
import { Onboarding } from "./onboarding.js";
import { ConnectClient } from "./connectClient.js";
import { WindowGate } from "./windowGate.js";
import { SimulatedScenario, SimulatedUpdater, UpdateController } from "./updates.js";
import { adversarialReview } from "./adversarialAgent.js";
import { ApprovalDecision, decideIntent, ReviewHint } from "./reviewPolicy.js";
import {
  isSignedIn,
  readAgentPurpose,
  readInference,
  setAgentPurpose,
  revokeAndSignOut,
  setApprovalMode,
  signOutOfPlow,
} from "./settingsActions.js";

// One folder per instance (paths.ts): the home carries everything, including
// Chromium's userData/sessionData at <home>/electron — never a second
// name-keyed "Plow Latch*" folder. Two instances sharing one userData
// contend on Chromium's LevelDB locks, so per-branch homes also keep
// from-source runs from tripping over each other or the packaged install.
// All of it must be set before the app is ready: the name so the macOS app
// menu, About/Hide/Quit items, and dock title read "Plow Latch" instead of
// "Electron", the paths so Chromium never opens the default locations.
const instance = resolveInstancePaths({ env: process.env, appData: app.getPath("appData") });
// A pre-rename "Domo…" home is moved to the new name here, before Chromium
// opens anything under it (migrateHome.ts explains why a rename is the whole
// migration). A failed move ABORTS startup — deliberately uncaught: see
// migrateHome.ts for why continuing would strand the old home for good.
if (migrateLegacyHome(instance.home)) {
  console.log(`[app] moved legacy home into ${instance.home}`);
}
// THE NAME SET HERE IS THE ONE THE KEYCHAIN SEES. Chromium captures the string
// it derives `<name> Safe Storage` from at startup, BEFORE `app.whenReady`, and
// a later `setName` does not move it (measured: an item is created under the
// pre-ready name and never under the post-ready one). So the frozen vault
// identity goes on first, and the display name is put back as the first thing
// in `whenReady` — early enough that the menus, windows and tray built after it
// all read the real product name.
app.setName(instance.vaultIdentity);
app.setPath("userData", instance.electronData);
app.setPath("sessionData", instance.electronData);

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(dirname, "renderer");

// Say what this build IS, once, where a diagnostic transcript starts. The
// stamped version + commit come from package.json (extraMetadata, `just
// package`); a from-source run has neither and says so.
const pkg = createRequire(import.meta.url)("../package.json") as { gitCommit?: string };
console.log(
  `[app] Plow Latch ${app.getVersion()}${app.isPackaged ? ` (${pkg.gitCommit ?? "no commit stamp"})` : " (from source)"}`,
);

// setName above rebrands the menus and dock title, but a from-source run is
// still the stock Electron.app bundle, so the Dock/Cmd-Tab icon stays
// Electron's. Repoint it at the repo artwork — dev only: the packaged app
// gets its icon from electron-builder (`mac.icon`) and doesn't ship the PNG.
// Once the app is ready, a DEV-ribboned version replaces it (see whenReady).
const devIconPath = path.join(dirname, "..", "..", "..", "artwork", "domo-desktop-icon.png");
if (!app.isPackaged) {
  app.dock?.setIcon(devIconPath);
}

/**
 * The badged icon: the artwork with a diagonal DEV ribbon (devIcon.ts).
 * Composited in a hidden sandboxed window because the main process can't
 * draw; only callable once the app is ready.
 */
async function devBadgedDockIcon(iconPath: string): Promise<Electron.NativeImage> {
  const png = await fs.readFile(iconPath);
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadURL("about:blank");
    const dataUrl: string = await win.webContents.executeJavaScript(
      devIconScript(png.toString("base64"), "DEV"),
    );
    return nativeImage.createFromDataURL(dataUrl);
  } finally {
    win.destroy();
  }
}

const home = instance.home;

/**
 * Which Plow this build talks to. Baked in — every build points at production,
 * including a run from source. There is no Settings field for it on purpose (a
 * credential is only valid against the environment that minted it), just a
 * developer env-var override a developer exports when they want another relay.
 */
const apiBaseUrl = resolveApiBaseUrl({ env: process.env });

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let device: DeviceAgent | null = null;
let mcp: DomoMcpServer | null = null;
let approvals: ApprovalStore | null = null;
let relay: RelayClient | null = null;
let onboarding: Onboarding | null = null;
let connectClient: ConnectClient | null = null;
let onboardingWindow: BrowserWindow | null = null;
let updates: UpdateController | null = null;

/**
 * Policy delegate that drives Electron approval windows. Each decision opens a
 * modal window rendering the intent's view model and resolves on the human's
 * click.
 */
class ElectronPolicy implements PolicyDelegate {
  // The branching itself lives in reviewPolicy.ts so it is testable without a
  // display; this only supplies the Electron-shaped pieces.
  async decideIntent(intent: Intent): Promise<{ decision: ApprovalDecision; source: string }> {
    const audit = device?.audit;
    return decideIntent(intent, {
      settings: loadSettings(home),
      apiBaseUrl,
      auditEntries: () => audit?.entries() ?? [],
      record: (event, fields) => audit?.record(event, fields),
      review: adversarialReview,
      openApproval: async (hint) =>
        openApprovalWindow(
          { kind: "intent", view: approvalViewModel(intent, await resolveCredentialTitles(intent)) },
          hint,
        ),
    });
  }
}

/**
 * Resolve credential item ids to titles via the LOCAL vault broker so the
 * approval card can show what the ids actually are. Never taken from the
 * intent — agent-supplied titles would be spoofable. Unresolvable ids render
 * as raw ids flagged "unknown item" (a deny signal for the human).
 */
async function resolveCredentialTitles(intent: Intent): Promise<CredentialTitles> {
  const titles: CredentialTitles = new Map();
  const broker = device?.credentialBroker;
  if (!broker) return titles;
  const items =
    intent.capabilities.find((c) => c.kind === "credential" && c.access === "fill")?.items ?? [];
  await Promise.all(
    items.map(async (id) => {
      try {
        const item = await broker.describeItem(id);
        titles.set(id, { title: item.title, category: item.category });
      } catch {
        /* unresolved — the card shows the raw id */
      }
    }),
  );
  return titles;
}

type ApprovalRequest = { kind: "intent"; view: ReturnType<typeof approvalViewModel> };

/** Serialize approval windows so two prompts never overlap. */
let approvalChain: Promise<unknown> = Promise.resolve();

function openApprovalWindow(
  request: ApprovalRequest,
  // Resolves to what the adversarial agent had to say, or null when it is not
  // being consulted at all.
  hint: Promise<ReviewHint> | null = null,
): Promise<ApprovalDecision> {
  const run = () =>
    new Promise<ApprovalDecision>((resolve) => {
      const win = new BrowserWindow({
        width: 460,
        height: 560,
        resizable: false,
        fullscreenable: false,
        title: "Plow Latch — Approve",
        webPreferences: {
          preload: path.join(dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      let settled = false;
      // The renderer subscribes only after it has built its DOM, and Electron
      // IPC has no replay — so a hint that resolved first would land on nobody.
      // An adversarial fallback hands over an ALREADY-RESOLVED promise, so that
      // is the common case, not a rare race. Waiting on both is what makes the
      // ordering stop mattering.
      let markReady = () => {};
      const ready = new Promise<void>((r) => {
        markReady = r;
      });
      const finish = (decision: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        ipcMain.removeHandler("approval:get");
        ipcMain.removeHandler("approval:ready");
        win.close();
        resolve(decision);
      };
      // The renderer pulls its model (never pushed with executable content).
      // `suggesting` tells it whether an adversarial review is in flight, so it
      // can show an indeterminate "reviewing…" indicator until the hint lands.
      ipcMain.handleOnce("approval:get", async () => ({ ...request, suggesting: !!hint }));
      // The renderer calls this once its suggestion listener is installed.
      // `handle`, not `handleOnce`: a second call must be a harmless no-op
      // rather than a rejected invoke in the renderer. Resolving twice is
      // already one. Both exits below remove it.
      ipcMain.handle("approval:ready", async () => markReady());
      const onDecision = (_e: unknown, id: string, decision: ApprovalDecision) => {
        if (id !== approvalId(request)) return;
        ipcMain.removeListener("approval:decide", onDecision);
        finish(decision);
      };
      ipcMain.on("approval:decide", onDecision);
      // When the adversarial agent responds, tell the window which button to
      // highlight (or that there's no hint) so it can clear the "reviewing…"
      // indicator. Only meaningful while the window is still open and unanswered.
      // Display-only, both fields. The enforceable bound the window shows is
      // the capability set in the view model, never this.
      if (hint) {
        void Promise.all([hint.catch(() => null), ready]).then(([said]) => {
          if (settled || win.isDestroyed()) return;
          win.webContents.send("approval:suggestion", {
            id: approvalId(request),
            decision: said?.decision ?? null,
            reason: said?.reason ?? "",
          });
        });
      }
      // Closing the window without a choice is a denial (fail safe).
      win.on("closed", () => {
        ipcMain.removeHandler("approval:ready");
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
    title: "Plow Latch",
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

// MARK: IPC for the main window (audit / rules / settings / status)

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
// Approvals still awaiting an answer, so the UI can show what is outstanding
// rather than relying on a window that may have been closed.
ipcMain.handle("approvals:pending", async () => (await approvals?.pending()) ?? []);
ipcMain.handle("rules:list", async () => device?.policy.allRules() ?? []);
ipcMain.handle("rules:remove", async (_e, key: string) => {
  device?.policy.removeRule(key);
  return device?.policy.allRules() ?? [];
});
ipcMain.handle("ui:getTab", async () => {
  const tab = loadSettings(home).selectedTab;
  // "connect" was this tab's key before the content went to Settings and came
  // back as "agents". Anyone who left the app on it lands where that content
  // lives now, rather than silently on the default tab.
  return tab === "connect" ? "agents" : tab;
});
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
/**
 * Forget this Mac's credential and put the user back at the start.
 *
 * The relay's `onAuthFailed` path only. Nobody clicked anything here: the
 * credential was retired on the account and the relay refused it, so there is
 * nothing to revoke and the window has to be OPENED — otherwise the app sits
 * silently disconnected with no way forward but quitting.
 *
 * `signOutOfPlow` rather than blanking the fields inline: losing the Plow
 * credential takes the Plow reviewer with it, and retiring Adversarial mode is
 * part of that same write.
 */
function signOut(): void {
  // `signOutOfPlow` rather than blanking the fields inline: losing the Plow
  // credential takes the Plow reviewer with it, and retiring Adversarial mode
  // is part of that same write.
  signOutOfPlow(home);
  onboarding?.reset();
  // Connect-a-client holds the old account's state too — possibly a shown-once
  // credential still on screen, or a mint in flight.
  connectClient?.signedOut();
  // The gate, not a bare `openOnboardingWindow`: with no credential this Mac is
  // not usable, so the main window goes away as the setup window arrives.
  // Opening it boots the renderer, which calls `begin` and mints the code the
  // activation screen needs. `begin` covers the already-open case; it is
  // idempotent, so between them exactly one code is minted.
  gate.sync();
  void onboarding?.begin();
}

// Sign out: retire the credential with Plow, forget it here, and drop the
// socket. The revoke is best-effort — see revokeAndSignOut — so a Mac that
// cannot reach Plow still signs out locally.
ipcMain.handle("settings:signOut", async () => {
  // A second click, before the button re-rendered. The first already signed
  // out; going round again would reset the setup window and mint a fresh code
  // over the one the user may have just texted.
  if (!isSignedIn(home)) return;
  // Started first: it clears the stored credential synchronously, before its
  // own first await, so everything below already sees a signed-out Mac. What it
  // returns is only the best-effort revoke, which nothing else waits on.
  const revoking = revokeAndSignOut(home, (credential) =>
    new PlowApi(apiBaseUrl).revokeDeviceCredential(credential),
  );
  // The one place that resets the app's state, shared with the relay's
  // auth-failed path. It also drops connect-a-client's shown-once credential,
  // which a click has exactly as much reason to clear as a revocation does.
  signOut();
  await startRelay();
  await revoking;
});
ipcMain.handle("onboarding:open", async () => openOnboardingWindow());

// MARK: IPC for "Connect a client" (main window)
//
// A pure read, like `onboarding:get` and for the same reason: the renderer
// re-reads on every change notification, so a getter that notifies is an
// unbroken re-render loop.
/**
 * Every web page the renderer may ask to open, in one table.
 *
 * The renderer names a KEY, never a URL. `openExternal` is pinned to URLs the
 * app composed itself — the `sms:` one, the vault's own address, and this
 * table — because a renderer that can hand main an arbitrary URL to open is a
 * renderer that can open anything. An unknown key opens nothing.
 *
 * `claude` deep-links into that client's "add a custom MCP connector" screen,
 * and is the only client entry on purpose. A connect card earns its place by
 * landing the user where they paste the URL, and Claude's link opens the
 * add-custom-connector modal directly. ChatGPT has no equivalent deep link —
 * the nearest target is a help article about enabling developer mode — so it
 * gets no card rather than a card that promises one click and delivers a
 * document. The connect step's own copy stays client-agnostic, so this table
 * growing is the only change a new client needs.
 *
 * `discord` and `website` are Settings' Support section; `account` is the
 * Plow web console, Settings' View Account button. It follows the build's API
 * origin so a `DOMO_API_BASE_URL` run opens the environment it signed into.
 *
 * `fullDiskSettings` is the one non-web entry: System Settings' Full Disk
 * Access pane. macOS has no API an app can call to request that permission —
 * sending the person to the switch IS the whole grant flow (see
 * fullDiskAccess.ts), so the deep link belongs in this table like any other
 * page the app may open.
 */
const EXTERNAL_URLS: Readonly<Record<string, string>> = Object.freeze({
  account: `${apiBaseUrl}/app/`,
  claude: "https://claude.ai/new?modal=add-custom-connector#settings/customize-connectors",
  discord: "https://watchmepivot.com/discord",
  website: "https://watchmepivot.com/",
  fullDiskSettings: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
});

ipcMain.handle("external:open", async (_e, key: string) => {
  const url = EXTERNAL_URLS[key];
  if (!url) return false;
  await shell.openExternal(url);
  return true;
});

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
ipcMain.handle("settings:setApprovalMode", async (_e, mode: string) => setApprovalMode(home, mode));
ipcMain.handle("settings:getShowSuggestions", async () => loadSettings(home).showAgentSuggestions ?? true);
ipcMain.handle("settings:setShowSuggestions", async (_e, on: boolean) => {
  const settings = loadSettings(home);
  settings.showAgentSuggestions = !!on;
  saveSettings(home, settings);
});
// What the owner says agents are for. This pair is the only way the text is
// written or read on the renderer's behalf; nothing an agent can reach touches
// it, which is what makes it trusted context for the reviewer.
ipcMain.handle("settings:getAgentPurpose", async () => readAgentPurpose(home));
ipcMain.handle("settings:setAgentPurpose", async (_e, purpose: string) =>
  setAgentPurpose(home, purpose),
);
/**
 * Everything the renderer is allowed to know about inference: whether the
 * reviewer can run, what it runs, and the stored mode. Deliberately booleans
 * and display strings — the relay credential never crosses this bridge.
 */
ipcMain.handle("settings:getInference", async () => readInference(home));
// The vault's contents, for the owner's own eyes and hands. This is the whole
// point of the tab: the vault's web page is the only other way in, and reaching
// it means a browser warning about a certificate the app issued to itself.
ipcMain.handle("vault:items", async () => {
  const vault = device?.vaultClient;
  const server = device?.vaultServer;
  if (!vault || !server) return null;
  // Locked and empty are different facts and the screen says different words.
  // An account that is on disk and will not open must never be reported as a
  // vault that has not started — that sent people to debug a running server.
  // Read BEFORE starting: a locked account is the very case where the vault's
  // own bootstrap cannot finish, and the explanation has to survive that.
  const locked = readCredentialsState(server.dataDir);
  if (locked.status === "locked") return { locked: true, reason: locked.reason };
  // Started, not merely launched: the account is written by the vault's first
  // run, so reading its state before that finishes reports an empty vault.
  await server.start();
  if (readCredentialsState(server.dataDir).status !== "ok") return null;
  // Every type, not only logins: a card and a note are things the owner keeps
  // here too, and the tab is where they are kept.
  return vault.list();
});

// One item to fill an edit form with — never a secret value; those are asked
// for one at a time, below.
ipcMain.handle("vault:item", async (_e, itemId: string) => {
  const vault = device?.vaultClient;
  if (!vault) throw new Error("the vault is not running");
  return vault.read(String(itemId));
});

// A value the OWNER asked to see, in the app window. It never touches a page,
// and the vault's audit records it as the owner's own reading.
ipcMain.handle("vault:reveal", async (_e, itemId: string, field: string) => {
  const vault = device?.vaultClient;
  if (!vault) throw new Error("the vault is not running");
  return vault.reveal(String(itemId), field);
});

ipcMain.handle("vault:deleteItem", async (_e, itemId: string) => {
  const vault = device?.vaultClient;
  if (!vault) throw new Error("the vault is not running");
  return vault.remove(String(itemId));
});

ipcMain.handle("vault:saveItem", async (_e, input: VaultItemInput) => {
  const vault = device?.vaultClient;
  if (!vault) throw new Error("the vault is not running");
  return vault.save(input);
});

// The live-browser thumbnail's whole state, one shape per poll (like
// onboarding:get). Frames come from the browser host directly, bypassing
// session scope: they are for the device owner's own eyes, and the owner
// watching an out-of-scope page is exactly the oversight the thumbnail exists
// for. `frame` is null while the browser is busy or restarting — the renderer
// keeps showing the frame it already has rather than flickering.
ipcMain.handle("viewer:state", async () => {
  const open = device?.browserSessions?.current() ?? null;
  const frame = open ? await device!.browserViewFrame() : null;
  // Re-read after the poll: the frame is newer than the snapshot that started
  // it, and a redirect landing in between would otherwise be drawn with the
  // new URL and the old verdict — an off-scope page labelled approved.
  const session = device?.browserSessions?.current() ?? null;
  return {
    active: session !== null,
    origins: session?.origins ?? [],
    inScope: session?.inScope ?? true,
    url: frame?.url ?? session?.lastUrl ?? "",
    frame: frame ? { dataB64: frame.dataB64, mime: frame.mime } : null,
  };
});
ipcMain.handle("status:get", async () => ({
  deviceId: device?.identity.deviceId ?? "",
  name: device?.identity.name ?? "",
  connected: connected,
}));
// macOS permission ceilings on the app itself — today just Full Disk Access.
// A fresh probe per read, because the answer changes outside the app (in
// System Settings) and there is no event to invalidate a cache on.
ipcMain.handle("capabilities:get", async () => ({
  fullDiskAccess: await probeFullDiskAccess(),
}));

// Launch at Login. macOS owns the bit and loginItem.ts owns the rules (fresh
// OS read per get, packaged-only writes); this is only the seam that hands it
// the real Electron API.
const loginItems: LoginItemApi = {
  get: () => app.getLoginItemSettings(),
  set: (settings) => app.setLoginItemSettings(settings),
};
ipcMain.handle("launch:get", async () => launchAtLoginState(app.isPackaged, loginItems));
ipcMain.handle("launch:set", async (_e, on: boolean) =>
  setLaunchAtLogin(app.isPackaged, loginItems, on),
);

/**
 * The one-time first-run default: a user who just set this Mac up wants it
 * reachable, so launch at login turns ON the moment setup hands over to the
 * app — and never again after that (`Settings.launchAtLoginDefaulted`), so
 * turning it off in Settings sticks.
 *
 * "Pending" is read entirely off disk: a credential with the marker still
 * false can only mean a completed setup whose default has not landed —
 * `finishWithSession` writes both fields, a home signed in from before the
 * marker existed reads as already defaulted (`loadSettings`), and sign-out
 * keeps the marker. So someone reopening the setup window from Settings never
 * trips this, no in-memory "signed in this session" flag is needed, and the
 * hook is idempotent — which is why it runs at BOTH the hand-over (the setup
 * window's closed handler) and startup: a crash between setup and the
 * hand-over leaves the default pending on disk, and the next launch opens the
 * main window directly, never closing a setup window.
 *
 * The attempt is the shot: if the OS declines the write we do not come back on
 * every launch — the Settings toggle is the recourse. A from-source run is the
 * one case that does NOT burn it (`supported` false writes nothing), so no dev
 * checkout enrolls the stock Electron binary and a packaged install's real
 * first run still gets its default.
 */
function applyFirstRunLaunchAtLogin(): void {
  const settings = loadSettings(home);
  if (settings.launchAtLoginDefaulted || !settings.relayCredential.trim()) return;
  if (setLaunchAtLogin(app.isPackaged, loginItems, true).supported) {
    settings.launchAtLoginDefaulted = true;
    saveSettings(home, settings);
  }
}

// MARK: IPC for software updates (banner + Software Updates settings section).
// One whole-state shape per read, renderer-side composition-free. In a
// from-source run there is no controller: supported=false and the section
// explains itself instead of pretending.
ipcMain.handle("updates:get", async () => {
  const settings = loadSettings(home);
  return {
    supported: !!updates,
    currentVersion: app.getVersion(),
    autoCheck: settings.autoCheckUpdates,
    autoInstall: settings.autoInstallUpdates,
    ...(updates?.state() ?? {
      phase: "idle",
      availableVersion: null,
      lastCheckAt: null,
      error: null,
      dismissed: false,
      upToDate: false,
    }),
  };
});
ipcMain.handle("updates:check", async () => updates?.checkNow());
ipcMain.handle("updates:restart", async () => updates?.restartAndInstall());
ipcMain.handle("updates:dismiss", async () => updates?.dismiss());
ipcMain.handle("updates:setAutoCheck", async (_e, on: boolean) => {
  const settings = loadSettings(home);
  settings.autoCheckUpdates = !!on;
  saveSettings(home, settings);
});
ipcMain.handle("updates:setAutoInstall", async (_e, on: boolean) => {
  const settings = loadSettings(home);
  settings.autoInstallUpdates = !!on;
  saveSettings(home, settings);
  // Takes effect immediately — this is the flag Squirrel honors at quit.
  if (updates) electronUpdater.autoUpdater.autoInstallOnAppQuit = !!on;
});

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
    title: "Plow Latch — Set Up",
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
    // Every hand-over from a completed setup to the main window closes this
    // window — Continue, the close box, the tray — so this is the one place
    // the first-run launch-at-login default lands.
    applyFirstRunLaunchAtLogin();
    // Closing the gate quits; closing the confirmation behind it hands over to
    // the app, the same as Continue. See WindowGate.setupClosed.
    gate.setupClosed();
  });
  void onboardingWindow.loadFile(path.join(rendererDir, "onboarding.html"));
}

/**
 * The login gate. Every path that changes whether this Mac holds a credential —
 * launch, the end of the wizard, sign-out, a credential the relay refuses —
 * ends in `gate.sync()`, and nothing else decides which window is open.
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
  quit: () => app.quit(),
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
    // The relay refused the credential — revoked in the console, or minted
    // against a different environment. It will never work again, so the app
    // signs itself out rather than reconnecting forever with a dead token.
    onAuthFailed: (reason) => {
      console.log(`[relay] credential rejected (${reason}); signing out`);
      connected = false;
      signOut();
      notifyRenderer("status:changed");
    },
    // RelayClient redacts the credential from everything it emits; this is the
    // only place its diagnostics reach a log at all.
    log: (message) => console.log(`[relay] ${message}`),
  });
  await relay.start();
}

/**
 * Bind `safeStorage` to the vault's frozen Keychain identity.
 *
 * ORDER MATTERS: `safeStorage` latches its key at first use and keeps it for
 * the life of the process, so this has to run before anything reads or writes
 * the vault account — and before any window exists, so the display name is back
 * in place by the time the menu is built.
 *
 * There is no migration here and there deliberately never was one that shipped:
 * the identity is frozen to the string every existing vault was already
 * encrypted under, so the ciphertext on disk just keeps working. Nothing is
 * copied, rewritten or prompted for.
 */
app.whenReady().then(async () => {
  // The Keychain has already captured the frozen vault identity (see the
  // setName at the top of this file). From here on the name is the product's,
  // for every menu, window and tray item built below.
  app.setName(instance.appName);
  // The dialog answers; the store writes down what was asked before it is
  // asked, so a pending approval is a record on disk rather than only a promise
  // in memory. It also bounds the wait: an approval nobody answers expires and
  // fails closed instead of pending forever.
  approvals = new ApprovalStore(path.join(home, "device/approvals"), new ElectronPolicy());
  // Packaged: the browser runtime lives in Contents/Resources/browser-runtime
  // (extraResources). In dev the resolver falls back to the repo's vendor/.
  device = new DeviceAgent(
    home,
    hostName(),
    approvals,
    resolveBrowserRuntime(process.resourcesPath),
  );
  // Same tick as the store's construction (see onAbandoned): an approval that
  // was pending when the app last quit gets closed out in the audit log too,
  // not only in the approvals directory.
  approvals.onAbandoned = (record) =>
    device?.audit.record("approval_abandoned", { intentId: record.intentId });
  // An item the vault marked "ask again" is not opened on the strength of the
  // app being unlocked. There is no master password to ask for here — the vault
  // account is a random string this app generated — so the Mac asks who is at
  // the keyboard instead, and refuses when it cannot.
  if (device.vaultClient) {
    device.vaultClient.onReprompt = async () => {
      if (!systemPreferences.canPromptTouchID()) return false;
      try {
        await systemPreferences.promptTouchID("show a vault item that asks for you");
        return true;
      } catch {
        return false;
      }
    };
  }
  // Say, once, whether this Mac can open its vault account. It is the one fact
  // about the vault that a log is good at: no secret, no noise, and it turns
  // "the vault screen looks wrong" into a one-line answer. `locked` means the
  // Keychain key for the frozen identity is not here — see vaultKeychain.ts.
  if (device.vaultServer) {
    const vaultState = readCredentialsState(device.vaultServer.dataDir);
    console.log(
      `[vault] account: ${vaultState.status}` +
        (vaultState.status === "locked" ? ` (${vaultState.reason})` : ""),
    );
  }
  // Live-refresh the audit view whenever a new event is recorded.
  device.audit.events.on("change", () => notifyRenderer("audit:changed"));
  mcp = createDomoMcpServer(device);
  await startRelay();

  onboarding = new Onboarding({
    api: new PlowApi(apiBaseUrl),
    home,
    startRelay,
    isConnected: () => connected,
    deviceName: `Plow Latch (${hostName()})`,
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

  // Only a packaged install updates: a from-source run has no app-update.yml
  // (and Squirrel.Mac could not swap a checkout anyway), so worktree instances
  // never poll the feed. Nothing here is modal: a downloaded update surfaces
  // as a banner in the main window, a tray item, and the Software Updates
  // settings section — the restart is always the human's call, and with the
  // auto-install preference on, a staged update applies on the next natural
  // quit anyway.
  // UI-only testing seam: DOMO_SIMULATE_UPDATE=available|none|error swaps in
  // a scripted fake updater — works from source, no packaging, no feed. The
  // controller, IPC, banner, tray, and settings section are all real; only
  // electron-updater is faked, and "Restart to Update" really relaunches.
  const simulate = (process.env.DOMO_SIMULATE_UPDATE ?? "").trim();
  if (app.isPackaged || simulate) {
    if (simulate) console.log(`[updates] SIMULATED updater active (${simulate}) — not a real update`);
    // Testing seam: point a packaged build at a feed that isn't production —
    // `just serve-updates` + DOMO_UPDATE_FEED_URL=http://127.0.0.1:8043 is the
    // whole local update loop. Safe to honor unconditionally: Squirrel.Mac
    // only installs an update signed by the same Developer ID as the running
    // app, so a hostile feed can offer nothing this app will accept.
    const feedOverride = (process.env.DOMO_UPDATE_FEED_URL ?? "").trim();
    if (feedOverride && !simulate) {
      electronUpdater.autoUpdater.setFeedURL({ provider: "generic", url: feedOverride });
      console.log(`[updates] feed overridden: ${feedOverride}`);
    }
    const settings = loadSettings(home);
    if (!simulate) electronUpdater.autoUpdater.autoInstallOnAppQuit = settings.autoInstallUpdates;
    updates = new UpdateController({
      updater: simulate ? simulatedUpdater(simulate) : electronUpdater.autoUpdater,
      // Read per tick, so the Settings toggle takes effect without a relaunch.
      autoCheckEnabled: () => loadSettings(home).autoCheckUpdates,
      initialLastCheckAt: settings.updatesLastCheckedAt ?? null,
      onChange: (state) => {
        // Persist the check time so "Last checked" survives a relaunch.
        if (state.lastCheckAt) {
          const s = loadSettings(home);
          if (s.updatesLastCheckedAt !== state.lastCheckAt) {
            s.updatesLastCheckedAt = state.lastCheckAt;
            saveSettings(home, s);
          }
        }
        refreshTray();
        notifyRenderer("updates:changed");
      },
      log: (message) => console.log(`[updates] ${message}`),
    });
    updates.start();
  }
  setupAppMenu();

  setupTray();
  // Swap the plain artwork set at startup for the DEV-ribboned version, so a
  // from-source Dock icon can't be mistaken for the packaged install. Purely
  // cosmetic: on any failure the plain icon just stays.
  if (!app.isPackaged && process.platform === "darwin") {
    void devBadgedDockIcon(devIconPath).then(
      (icon) => app.dock?.setIcon(icon),
      (err) => console.log(`[dev-icon] badge failed, keeping plain icon: ${err}`),
    );
  }
  // A crash between setup saving the credential and the hand-over would leave
  // the first-run default pending on disk with no setup window left to close —
  // and this launch goes straight to the main window, so the hand-over hook
  // never runs. Settle it here; every already-settled home returns early.
  applyFirstRunLaunchAtLogin();
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
  // Kill any live Camoufox session/process group so Firefox children don't outlive us.
  void device?.shutdown();
});

app.on("window-all-closed", () => {
  // Stay resident in the tray — Plow Latch is a menu-bar agent, not a document app.
});

// Block any attempt to navigate to remote content or open external windows —
// the approval surface must never load anything but our local files. "Any
// file://" is not narrow enough: the preload bridge survives a navigation, and
// it now reaches the vault, so a local HTML file an attacker can write would
// inherit it. Only the documents we ship are allowed.
const OUR_DOCUMENTS = ["index.html", "onboarding.html", "approval.html"].map((f) =>
  pathToFileURL(path.join(rendererDir, f)).href,
);
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-navigate", (event, url) => {
    if (!OUR_DOCUMENTS.includes(url.split("?")[0].split("#")[0])) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

function setupTray(): void {
  // A 1x1 transparent placeholder keeps the tray API happy without an asset
  // pipeline; a real template image ships with the packaged app.
  const image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip(instance.trayTooltip);
  refreshTray();
}

/** (Re)build the tray menu — its update item tracks the controller's state. */
function refreshTray(): void {
  if (!tray) return;
  const state = updates?.state();
  const menu = Menu.buildFromTemplate([
    // Through the gate, so the tray cannot hand back a main window this Mac is
    // not entitled to.
    { label: "Open Plow Latch", click: () => gate.sync() },
    // Update items only when an updater exists (packaged runs) — a dead menu
    // item in a from-source run would just be a lie.
    ...(updates
      ? [
          state?.phase === "ready"
            ? {
                label: `Restart to Update (${state.availableVersion})`,
                click: () => updates?.restartAndInstall(),
              }
            : { label: "Check for Updates…", click: () => checkForUpdatesFromMenu() },
        ]
      : []),
    { type: "separator" },
    { label: "Quit Plow Latch", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

/**
 * The menu-bar/tray "Check for Updates…": start the check, then bring up the
 * main window on the Settings tab, where the Software Updates section shows
 * the outcome — the passive answer to what Sparkle does with a modal.
 */
function checkForUpdatesFromMenu(): void {
  updates?.checkNow();
  // Through the gate: a Mac that is not signed in has no main window to show
  // the outcome in, and must not be given one from here. `mainWindow` is null
  // in that case and the send below is a no-op.
  gate.sync();
  const send = () => mainWindow?.webContents.send("ui:showSettings");
  if (mainWindow?.webContents.isLoading()) mainWindow.webContents.once("did-finish-load", send);
  else send();
}

/**
 * The macOS application menu. Replacing the default menu costs the stock
 * items, so the standard roles (File for Close, Edit for clipboard, Window)
 * are declared explicitly — a sandboxed renderer still needs working
 * Cmd-C/V. The View
 * menu (reload, devtools) is dev-only noise and ships only from source.
 */
function setupAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        ...(updates
          ? ([
              { type: "separator" },
              { label: "Check for Updates…", click: () => checkForUpdatesFromMenu() },
            ] as Electron.MenuItemConstructorOptions[])
          : []),
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        // Through the gate, so this cannot hand back a main window a Mac
        // that is not signed in is not entitled to. Not Cmd-0 — the dev-only
        // View menu's "Actual Size" (resetZoom) already claims that.
        { label: "Show Main Window", accelerator: "CmdOrCtrl+1", click: () => gate.sync() },
        { type: "separator" },
        // Close (Cmd-W) lives in File on macOS; windowMenu omits it there, so
        // without this item the accelerator binds to nothing app-wide. Closing
        // an approval window without deciding is already a denial (fail safe).
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { role: "windowMenu" },
    ...(!app.isPackaged ? ([{ role: "viewMenu" }] as Electron.MenuItemConstructorOptions[]) : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Build the DOMO_SIMULATE_UPDATE fake: any value but "none"/"error" plays the
 * happy path. The pretend update is the current version with its patch +1 —
 * visibly newer, obviously fake. "Installing" it relaunches the app for real,
 * so the whole banner → restart → fresh-launch arc is walkable in dev.
 */
function simulatedUpdater(value: string): SimulatedUpdater {
  const scenario: SimulatedScenario =
    value === "none" || value === "error" ? value : "available";
  const [major = "0", minor = "0", patch = "0"] = app.getVersion().split(".");
  return new SimulatedUpdater({
    scenario,
    version: `${major}.${minor}.${Number(patch) + 1 || 1}`,
    onInstall: () => {
      console.log("[updates] simulated install — relaunching");
      app.relaunch();
      app.quit();
    },
  });
}

function hostName(): string {
  try {
    return os.hostname();
  } catch {
    return "Mac";
  }
}
