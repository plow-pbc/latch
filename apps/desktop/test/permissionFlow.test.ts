/**
 * The drag-to-authorize target (permissionFlow.ts): which .app bundle a
 * process's executable path names. Pure path logic, so every shape runs here —
 * the packaged app, a from-source electron run, a nested helper bundle, and
 * hosts with no bundle at all.
 */
import { describe, expect, it } from "vitest";
import {
  appBundleName,
  appBundlePath,
  createFrameStreamParser,
  fallbackPanelFrame,
  panelFrame,
} from "../src/permissionFlow.js";

describe("appBundlePath", () => {
  it("resolves the packaged app's bundle", () => {
    expect(appBundlePath("/Applications/Plow Latch.app/Contents/MacOS/Plow Latch"))
      .toBe("/Applications/Plow Latch.app");
  });

  it("resolves a from-source run to electron's own bundle", () => {
    expect(appBundlePath("/w/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"))
      .toBe("/w/node_modules/electron/dist/Electron.app");
  });

  it("picks the shallowest bundle, never a nested helper", () => {
    expect(appBundlePath(
      "/Applications/Plow Latch.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
    )).toBe("/Applications/Plow Latch.app");
  });

  it("returns null when no ancestor is a bundle", () => {
    expect(appBundlePath("/usr/local/bin/node")).toBeNull();
  });

  it("never treats the executable itself as the bundle", () => {
    expect(appBundlePath("/opt/tools/weird.app")).toBeNull();
  });

  it("ignores a bare .app path component", () => {
    expect(appBundlePath("/srv/.app/bin/run")).toBeNull();
  });
});

describe("appBundleName", () => {
  it("strips the extension", () => {
    expect(appBundleName("/Applications/Plow Latch.app")).toBe("Plow Latch");
  });
});

const workArea = { x: 0, y: 0, width: 1920, height: 1055 };

describe("panelFrame", () => {
  it("sits below the Settings window, aligned past the sidebar", () => {
    const settings = { x: 400, y: 200, width: 800, height: 600 };
    expect(panelFrame(settings, workArea, 96)).toEqual({
      x: 630, // 400 + the 230pt sidebar
      y: 800, // directly under the window
      width: 570, // the content column: 800 - 230
      height: 96,
    });
  });

  it("clamps into the work area when Settings hugs an edge", () => {
    const settings = { x: 1500, y: 900, width: 800, height: 500 };
    const frame = panelFrame(settings, workArea, 96);
    expect(frame.x + frame.width).toBeLessThanOrEqual(workArea.width - 12);
    expect(frame.y + frame.height).toBeLessThanOrEqual(workArea.height - 12);
  });

  it("keeps a usable minimum width for a narrow Settings window", () => {
    const settings = { x: 100, y: 100, width: 300, height: 500 };
    expect(panelFrame(settings, workArea, 96).width).toBe(240);
  });

  it("never exceeds the work area on a small screen", () => {
    const small = { x: 0, y: 0, width: 500, height: 400 };
    const settings = { x: 0, y: 0, width: 800, height: 350 };
    expect(panelFrame(settings, small, 96).width).toBe(500 - 24);
  });
});

describe("fallbackPanelFrame", () => {
  it("centers near the bottom of the work area", () => {
    expect(fallbackPanelFrame(workArea, { width: 420, height: 96 })).toEqual({
      x: 750,
      y: 1055 - 96 - 48,
      width: 420,
      height: 96,
    });
  });
});

describe("createFrameStreamParser", () => {
  it("parses complete lines into frames, front defaulting true", () => {
    const parse = createFrameStreamParser();
    expect(parse('{"x":1,"y":2,"width":3,"height":4}\n')).toEqual({
      frames: [{ x: 1, y: 2, width: 3, height: 4, front: true }],
      gone: false,
    });
  });

  it("carries the frontmost bit through", () => {
    const parse = createFrameStreamParser();
    expect(parse('{"x":1,"y":2,"width":3,"height":4,"front":false}\n').frames[0].front).toBe(false);
  });

  it("reassembles a line split across chunks", () => {
    const parse = createFrameStreamParser();
    expect(parse('{"x":1,"y":2,"wi').frames).toEqual([]);
    expect(parse('dth":3,"height":4}\n{"x":5,"y":6,"width":7,"height":8}\n').frames).toEqual([
      { x: 1, y: 2, width: 3, height: 4, front: true },
      { x: 5, y: 6, width: 7, height: 8, front: true },
    ]);
  });

  it("reports the gone sentinel", () => {
    const parse = createFrameStreamParser();
    expect(parse('{"gone":true}\n').gone).toBe(true);
  });

  it("drops malformed and shape-less lines without ending the stream", () => {
    const parse = createFrameStreamParser();
    const out = parse('not json\n{"x":"a"}\n{"x":1,"y":2,"width":3,"height":4}\n');
    expect(out).toEqual({ frames: [{ x: 1, y: 2, width: 3, height: 4, front: true }], gone: false });
  });
});
