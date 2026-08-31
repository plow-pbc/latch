/**
 * The Full Disk Access grant flow's moving parts — the floating panel and the
 * System Settings tracker. See permissionFlow.ts for the port rationale and
 * the pure geometry/parsing it keeps testable; this module is the thin
 * Electron layer over it, deliberately shaped like PermissionFlow's
 * controller:
 *
 *   - one panel at a time, non-activating, floating level, all workspaces
 *   - it follows the System Settings window via the compiled helper
 *     (native/settings-window-frame.swift); with no helper it sits at a fixed
 *     fallback spot and everything else still works
 *   - the flow ends when the grant lands (a fresh probe every 2s), when
 *     System Settings closes, or on a hard timeout — an abandoned flow must
 *     not leave a floating window or a polling child process behind.
 */
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { BrowserWindow, screen } from "electron";
import {
  decodeFrameLine,
  fallbackPanelFrame,
  panelFrame,
  Rect,
} from "./permissionFlow.js";

const PANEL_HEIGHT = 100;
const FALLBACK_PANEL_WIDTH = 420;
const PROBE_INTERVAL_MS = 2000;
const FLOW_TIMEOUT_MS = 3 * 60 * 1000;
// Long enough for the panel's own 1.5s status poll to paint the granted
// header, and for a human to read it, before the panel goes away.
const GRANTED_LINGER_MS = 2500;

export interface FdaGrantFlowDeps {
  /** dist/renderer — where fdapanel.html lives. */
  rendererDir: string;
  /** The sandboxed preload every window shares. */
  preloadPath: string;
  /** The compiled tracker, or a path that may not exist (flow degrades). */
  helperPath: string;
  /** A fresh Full Disk Access probe (fullDiskAccess.ts). */
  probe: () => Promise<boolean>;
  /** Opens the System Settings pane (main's EXTERNAL_URLS deep link). */
  openSettings: () => Promise<void>;
}

export class FdaGrantFlow {
  private panel: BrowserWindow | null = null;
  private helper: ChildProcess | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private timeoutTimer: NodeJS.Timeout | null = null;
  // The panel shows only while System Settings is frontmost (the tracker's
  // `front` bit) — floating over someone else's window is noise. Both bits
  // must be true before the panel is ordered in: readiness so a still-loading
  // window never flashes, and wantVisible so an occluded Settings keeps the
  // panel away.
  private panelReady = false;
  private wantVisible = false;
  // While the person is mid-gesture on the panel (mouse down, drag about to
  // start or riding), a frontmost flicker must not hide it — hiding the drag
  // source aborts the drag. Held from the tile's pointerdown until the drag
  // session ends or the pointer lifts, with a timeout so a lost release can
  // never pin the panel open forever.
  private holdVisible = false;
  private holdTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: FdaGrantFlowDeps) {}

  /**
   * Begin (or re-front) the flow. Idempotent on purpose: a second click while
   * the panel is up re-opens the Settings pane and keeps the one panel —
   * PermissionFlow keeps a single floating panel for the same reason.
   */
  async start(): Promise<void> {
    // The deep link (re-)fronts System Settings; with a tracker running that
    // is also what brings an existing panel back on screen.
    void this.deps.openSettings();
    if (this.panel) return;
    // Already granted: nothing to guide. The pane still opens — that's where
    // the grant is viewed or revoked — but a panel asking for what is already
    // given would only confuse. (Re-checked after the await: a second click
    // may have built the panel while the probe ran.)
    if (await this.deps.probe()) return;
    if (this.panel) return;

    const workArea = screen.getPrimaryDisplay().workArea;
    const bounds = fallbackPanelFrame(workArea, {
      width: FALLBACK_PANEL_WIDTH,
      height: PANEL_HEIGHT,
    });
    const panel = new BrowserWindow({
      ...bounds,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      closable: true,
      // Non-activating: System Settings stays the visible focus owner, like
      // PermissionFlow's .nonactivatingPanel. A native drag works fine from
      // an unfocused window. `type: "panel"` is what makes a CLICK
      // non-activating too — without it, mousing down on the tile brought
      // this app forward, Settings lost frontmost, and the tracker hid the
      // panel out from under the drag.
      type: "panel",
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      // The chrome is the renderer's rounded card (PermissionFlow's 18pt
      // rounded material panel); the window itself stays clear so the corners
      // actually round.
      transparent: true,
      show: false,
      title: "Grant Full Disk Access",
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.panel = panel;
    panel.setAlwaysOnTop(true, "floating");
    panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    panel.on("closed", () => {
      // Closed from outside (or by the person somehow): tear the rest down.
      this.panel = null;
      this.stop();
    });
    void panel.loadFile(path.join(this.deps.rendererDir, "fdapanel.html"));
    this.startTracker();
    // With no tracker there is no frontmost signal, so the fallback panel just
    // shows; with one, it appears the first time Settings is reported front.
    this.panelReady = false;
    this.wantVisible = this.helper === null;
    panel.once("ready-to-show", () => {
      this.panelReady = true;
      this.applyVisibility();
    });

    this.probeTimer = setInterval(() => void this.checkGranted(), PROBE_INTERVAL_MS);
    this.timeoutTimer = setTimeout(() => this.stop(), FLOW_TIMEOUT_MS);
  }

  stop(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.probeTimer = null;
    this.timeoutTimer = null;
    this.holdTimer = null;
    this.holdVisible = false;
    this.helper?.kill();
    this.helper = null;
    const panel = this.panel;
    this.panel = null;
    if (panel && !panel.isDestroyed()) panel.destroy();
  }

  /**
   * Follow System Settings. No helper binary (no Swift toolchain at build
   * time, or a non-mac host) is not an error: the panel stays where the
   * fallback put it, and the drag still works from there.
   */
  private startTracker(): void {
    if (!fs.existsSync(this.deps.helperPath)) return;
    const helper = spawn(this.deps.helperPath, [], { stdio: ["ignore", "pipe", "ignore"] });
    this.helper = helper;
    // readline frames the stream — the same seam the browser host uses for
    // child NDJSON; decodeFrameLine only decodes.
    readline.createInterface({ input: helper.stdout! }).on("line", (line) => {
      const decoded = decodeFrameLine(line);
      if (decoded === null) return;
      if (decoded === "gone") {
        // Settings closed; the flow's reason to float is gone with it.
        this.stop();
        return;
      }
      this.snapTo(decoded);
      this.wantVisible = decoded.front;
      this.applyVisibility();
    });
    // A helper that dies — or never spawns: `error` fires for a binary the
    // existsSync check passed but posix_spawn refused, say a wrong-arch
    // slice, and with no listener that exception would take down the main
    // process — just ends following. The panel holds its last position, and
    // with no frontmost signal left it stays visible rather than stuck
    // hidden.
    const degrade = () => {
      if (this.helper !== helper) return;
      this.helper = null;
      this.wantVisible = true;
      this.applyVisibility();
    };
    helper.on("exit", degrade);
    helper.on("error", degrade);
  }

  /** Keep (or stop keeping) the panel on screen regardless of the frontmost
   * signal — the mid-gesture guard described on holdVisible. */
  setHold(on: boolean): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = on
      ? setTimeout(() => this.setHold(false), 30_000)
      : null;
    this.holdVisible = on;
    this.applyVisibility();
  }

  /** Order the panel in or out to match wantVisible (or an active gesture
   * hold), once it can be shown at all. showInactive keeps System Settings
   * the focus owner. */
  private applyVisibility(): void {
    const panel = this.panel;
    if (!panel || panel.isDestroyed() || !this.panelReady) return;
    const show = this.wantVisible || this.holdVisible;
    if (show && !panel.isVisible()) panel.showInactive();
    else if (!show && panel.isVisible()) panel.hide();
  }

  private snapTo(settingsFrame: Rect): void {
    const panel = this.panel;
    if (!panel || panel.isDestroyed()) return;
    const workArea = screen.getDisplayMatching(settingsFrame).workArea;
    panel.setBounds(panelFrame(settingsFrame, workArea, PANEL_HEIGHT));
  }

  private async checkGranted(): Promise<void> {
    if (!(await this.deps.probe())) return;
    // Let the panel's own poll paint the granted state, then leave.
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
    setTimeout(() => this.stop(), GRANTED_LINGER_MS);
  }
}
