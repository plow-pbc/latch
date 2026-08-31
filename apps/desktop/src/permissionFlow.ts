/**
 * Full Disk Access grant flow — the drag-to-authorize target.
 *
 * Ported from PermissionFlow (github.com/plow-pbc/PermissionFlow): a
 * Swift/SwiftUI library, so it cannot be linked into an Electron app — what is
 * integrated is its flow. The System Settings Full Disk Access pane accepts a
 * dropped .app bundle the same way its "+" button does, so the grant flow
 * opens the pane and floats a small always-on-top panel next to it with the
 * app as a native drag source, following the Settings window as it moves
 * (native/settings-window-frame.swift is the tracker; fdaGrantFlow.ts is the
 * orchestration), while the status re-probes on a short interval so the grant
 * lands green the moment it happens.
 *
 * Pure Node on purpose, like fullDiskAccess.ts: the target resolution, panel
 * geometry and tracker-stream parsing live here, unit-testable without
 * Electron; everything that needs Electron stays in fdaGrantFlow.ts.
 */
import path from "node:path";

/**
 * The .app bundle that owns this process, from its executable path — the thing
 * to drag into the Full Disk Access list, and the thing TCC keys the grant on.
 *
 * A packaged run is `…/Plow Latch.app/Contents/MacOS/Plow Latch`; a
 * from-source run is electron's own `Electron.app`, which is exactly what a
 * dev grant must name. The SHALLOWEST `.app` ancestor wins so a helper bundle
 * nested inside the main one never becomes the target. Null when no ancestor
 * is a bundle (plain node, non-mac test hosts) — the renderer then shows no
 * drag tile and the deep link stands alone.
 */
export function appBundlePath(execPath: string): string | null {
  const parts = execPath.split(path.sep);
  // The executable lives INSIDE the bundle, so the last component can't be it.
  const i = parts.slice(0, -1).findIndex((p) => p.endsWith(".app") && p !== ".app");
  return i < 0 ? null : parts.slice(0, i + 1).join(path.sep);
}

/** Display name for the drag tile: the bundle's basename without ".app". */
export function appBundleName(bundlePath: string): string {
  return path.basename(bundlePath, ".app");
}

/** Global top-left screen coordinates, in points — Electron's screen space on
 * macOS, and what native/settings-window-frame.swift emits. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * System Settings' leading sidebar width. The panel aligns to the trailing
 * content area rather than the full window because the sidebar is not the
 * user's active target — PermissionFlow's constant, and like theirs it is a
 * visual tuning value, not something the window server reports.
 */
const SIDEBAR_WIDTH = 230;
const SCREEN_INSET = 12;
const MIN_PANEL_WIDTH = 240;

/**
 * Where the floating panel sits for a given System Settings frame: directly
 * below the window, spanning its content column, clamped into the screen's
 * work area so a Settings window dragged to an edge never pushes the panel
 * off-screen. A direct port of FloatingDropPanel.targetFrame, in top-left
 * coordinates (no AppKit flip: both inputs and output are Electron's space).
 */
export function panelFrame(settings: Rect, workArea: Rect, panelHeight: number): Rect {
  const width = Math.round(Math.min(
    Math.max(MIN_PANEL_WIDTH, settings.width - SIDEBAR_WIDTH),
    workArea.width - SCREEN_INSET * 2,
  ));
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  return {
    x: Math.round(clamp(
      settings.x + SIDEBAR_WIDTH,
      workArea.x + SCREEN_INSET,
      workArea.x + workArea.width - width - SCREEN_INSET,
    )),
    y: Math.round(clamp(
      settings.y + settings.height,
      workArea.y + SCREEN_INSET,
      workArea.y + workArea.height - panelHeight - SCREEN_INSET,
    )),
    width,
    height: panelHeight,
  };
}

/**
 * Where the panel goes while no Settings frame is known — before the tracker's
 * first report, and for the whole flow on a Mac without the compiled helper:
 * centered near the bottom of the work area, out of System Settings' likely
 * (centered) landing spot but unmistakably present.
 */
export function fallbackPanelFrame(workArea: Rect, size: { width: number; height: number }): Rect {
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + workArea.height - size.height - SCREEN_INSET * 4),
    width: size.width,
    height: size.height,
  };
}

/** One tracker report: where System Settings is, and whether it is the
 * frontmost app — the panel only belongs on screen while it is. `front`
 * defaults to true when a frame line omits it. */
export interface SettingsFrame extends Rect {
  front: boolean;
}

/**
 * Decoder for ONE line of the helper's stdout — framing is readline's job
 * (the same seam the browser host uses for child NDJSON). "gone" is the
 * Settings-closed sentinel; null is a malformed or shape-less line, dropped
 * rather than ending tracking, because the next report supersedes it anyway.
 */
export function decodeFrameLine(line: string): SettingsFrame | "gone" | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  if (o.gone === true) return "gone";
  if (
    typeof o.x === "number" && typeof o.y === "number" &&
    typeof o.width === "number" && typeof o.height === "number"
  ) {
    return { x: o.x, y: o.y, width: o.width, height: o.height, front: o.front !== false };
  }
  return null;
}
