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
  decodeFrameLine,
  decodeTileImage,
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

describe("decodeTileImage", () => {
  // A real (1×1) PNG: the decoder checks the signature, not just the mime.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const url = `data:image/png;base64,${png.toString("base64")}`;

  it("decodes a PNG data URL at a real display scale", () => {
    const decoded = decodeTileImage(url, 2);
    expect(decoded?.scaleFactor).toBe(2);
    expect(decoded?.png.equals(png)).toBe(true);
  });

  it("rejects a scale outside 1–3 or not a finite number", () => {
    expect(decodeTileImage(url, 0.5)).toBeNull();
    expect(decodeTileImage(url, 4)).toBeNull();
    expect(decodeTileImage(url, NaN)).toBeNull();
    expect(decodeTileImage(url, "2")).toBeNull();
  });

  it("rejects anything that is not a PNG data URL", () => {
    expect(decodeTileImage(null, 2)).toBeNull();
    expect(decodeTileImage("data:image/jpeg;base64,AAAA", 2)).toBeNull();
    // Claims the mime but does not carry the PNG signature.
    expect(decodeTileImage("data:image/png;base64,AAAAAAAAAAAA", 2)).toBeNull();
  });

  it("rejects an outsized payload", () => {
    const big = `data:image/png;base64,${"A".repeat(4 * 1024 * 1024 + 4)}`;
    expect(decodeTileImage(big, 2)).toBeNull();
  });
});

describe("decodeFrameLine", () => {
  it("decodes a frame line, front defaulting true", () => {
    expect(decodeFrameLine('{"x":1,"y":2,"width":3,"height":4}'))
      .toEqual({ x: 1, y: 2, width: 3, height: 4, front: true });
  });

  it("carries the frontmost bit through", () => {
    const frame = decodeFrameLine('{"x":1,"y":2,"width":3,"height":4,"front":false}');
    expect(frame).toMatchObject({ front: false });
  });

  it("reports the gone sentinel", () => {
    expect(decodeFrameLine('{"gone":true}')).toBe("gone");
  });

  it("drops malformed and shape-less lines rather than ending tracking", () => {
    expect(decodeFrameLine("not json")).toBeNull();
    expect(decodeFrameLine('{"x":"a"}')).toBeNull();
    expect(decodeFrameLine("")).toBeNull();
  });
});
