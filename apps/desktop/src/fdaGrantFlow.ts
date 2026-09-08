/**
 * The grant flow's moving parts — the floating panel and the System Settings
 * tracker. See permissionFlow.ts for the port rationale and the pure
 * geometry/parsing it keeps testable; this module is the thin Electron layer
 * over it, deliberately shaped like PermissionFlow's controller:
 *
 *   - one panel at a time, non-activating, floating level, all workspaces
 *   - it follows the System Settings window via the compiled helper
 *     (native/settings-window-frame.swift); with no helper it sits at a fixed
 *     fallback spot and everything else still works
 *   - the flow ends when the grant lands (a fresh probe every 2s), when
 *     System Settings closes, or on a hard timeout — an abandoned flow must
 *     not leave a floating window or a polling child process behind.
 *
 * Built for Full Disk Access and now aimed at any Privacy & Security pane
 * (`GrantTarget`): the pane to open, the switch's name, whether that pane
 * accepts a dropped app (Full Disk Access and Accessibility do — the panel
 * shows its drag tile; the rest list only apps that asked, and the panel
 * points at the switch instead), and the probe that says when the grant has
 * landed. The file keeps its name because the panel is still the one
 * PermissionFlow drew; only where it points changed.
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

/** The panel's height until the renderer has measured its own content: one
 *  header line plus the tile. The renderer reports the height it actually
 *  needs (a two-line header for a long switch name), and the window follows. */
const PANEL_HEIGHT = 100;
const MIN_PANEL_HEIGHT = 80;
const MAX_PANEL_HEIGHT = 240;
const FALLBACK_PANEL_WIDTH = 420;
const PROBE_INTERVAL_MS = 2000;
const FLOW_TIMEOUT_MS = 3 * 60 * 1000;
// Long enough for the panel's own 1.5s status poll to paint the granted
// header, and for a human to read it, before the panel goes away.
const GRANTED_LINGER_MS = 2500;

/** One switch the panel can float beside. */
export interface GrantTarget {
  /** The row key (capabilitiesModel.ts), for the panel's status poll. */
  key: string;
  /** The switch's name in System Settings' words: "Full Disk Access". */
  label: string;
  /** The pane's deep link. */
  pane: string;
  /** Whether the pane accepts a dropped app — the drag tile, or a pointer. */
  acceptsDrop: boolean;
  /** Whether the grant has landed; polled every 2s while the panel is up. */
  probe: () => Promise<boolean>;
}

export interface FdaGrantFlowDeps {
  /** dist/renderer — where fdapanel.html lives. */
  rendererDir: string;
  /** The sandboxed preload every window shares. */
  preloadPath: string;
  /** The compiled tracker, or a path that may not exist (flow degrades). */
  helperPath: string;
  /** The default target: Full Disk Access, with the device's own probe. */
  fullDisk: GrantTarget;
  /** Opens a System Settings pane by deep link. */
  openSettings: (pane: string) => Promise<void>;
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
  /** The switch the panel is currently pointing at. */
  private target: GrantTarget | null = null;
  /** The height the panel's content needs, as the renderer last measured it. */
  private height = PANEL_HEIGHT;
  /** Where System Settings last was, so a height change can re-snap. */
  private lastSettingsFrame: Rect | null = null;

  constructor(private readonly deps: FdaGrantFlowDeps) {}

  /** What the panel is pointing at right now, for its own rendering. */
  current(): GrantTarget | null {
    return this.target;
  }

  /**
   * Begin (or re-front) the flow for one switch — Full Disk Access when none
   * is named. Idempotent on purpose: a second click while the panel is up
   * re-opens the pane and keeps the one panel — PermissionFlow keeps a single
   * floating panel for the same reason. A click for a DIFFERENT switch while
   * one is up ends that flow and starts this one: one panel, one switch.
   */
  async start(target: GrantTarget = this.deps.fullDisk): Promise<void> {
    if (this.panel && this.target && this.target.key !== target.key) this.stop();
    this.target = target;
    // The deep link (re-)fronts System Settings; with a tracker running that
    // is also what brings an existing panel back on screen.
    void this.deps.openSettings(target.pane);
    if (this.panel) return;
    // Already granted: nothing to guide. The pane still opens — that's where
    // the grant is viewed or revoked — but a panel asking for what is already
    // given would only confuse. (Re-checked after the await: a second click
    // may have built the panel while the probe ran.)
    if (await target.probe()) return;
    if (this.panel) return;

    const workArea = screen.getPrimaryDisplay().workArea;
    this.height = PANEL_HEIGHT;
    this.lastSettingsFrame = null;
    const bounds = fallbackPanelFrame(workArea, {
      width: FALLBACK_PANEL_WIDTH,
      height: this.height,
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
      title: `Grant ${target.label}`,
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
    this.lastSettingsFrame = settingsFrame;
    const workArea = screen.getDisplayMatching(settingsFrame).workArea;
    panel.setBounds(panelFrame(settingsFrame, workArea, this.height));
  }

  /**
   * The renderer measured its content: a header that wrapped to two lines
   * needs a taller window, or the panel's tile is pushed out of the frame
   * (the window's height was a constant; the header's length is not). The
   * width is the tracker's business and stays; only the height follows,
   * keeping the panel's top edge where it was.
   */
  setHeight(height: number): void {
    const wanted = Math.round(Math.max(MIN_PANEL_HEIGHT, Math.min(height, MAX_PANEL_HEIGHT)));
    if (wanted === this.height) return;
    this.height = wanted;
    const panel = this.panel;
    if (!panel || panel.isDestroyed()) return;
    if (this.lastSettingsFrame) {
      this.snapTo(this.lastSettingsFrame);
    } else {
      const b = panel.getBounds();
      panel.setBounds({ ...b, height: wanted });
    }
  }

  private async checkGranted(): Promise<void> {
    const target = this.target;
    if (!target || !(await target.probe())) return;
    // Let the panel's own poll paint the granted state, then leave.
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
    setTimeout(() => this.stop(), GRANTED_LINGER_MS);
  }
}
