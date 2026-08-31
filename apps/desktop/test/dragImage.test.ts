/**
 * The drag-image anchor fix (renderer/dragImage.js): Electron centers a drag
 * image on the cursor, so the tile raster is padded until the grab point IS
 * the center. The invariant under test: wherever the tile is grabbed, the
 * padded box's center sits exactly `gx`/`gy` into the drawn raster — that is
 * what keeps the tile from shifting as it lifts off the panel.
 */
import { describe, expect, it } from "vitest";
import { grabAlignedBox } from "../src/renderer/dragImage.js";

const centerLandsOnGrab = (w: number, h: number, gx: number, gy: number) => {
  const box = grabAlignedBox(w, h, gx, gy);
  expect(box.width / 2 - box.x).toBeCloseTo(Math.min(Math.max(gx, 0), w));
  expect(box.height / 2 - box.y).toBeCloseTo(Math.min(Math.max(gy, 0), h));
  // The raster always fits inside the padding.
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + w).toBeLessThanOrEqual(box.width);
  expect(box.y + h).toBeLessThanOrEqual(box.height);
  return box;
};

describe("grabAlignedBox", () => {
  it("a dead-center grab needs no padding", () => {
    expect(grabAlignedBox(400, 60, 200, 30)).toEqual({ width: 400, height: 60, x: 0, y: 0 });
  });

  it("a left-edge grab pads leftward so the tile stays put", () => {
    const box = centerLandsOnGrab(400, 60, 50, 30);
    expect(box).toMatchObject({ width: 700, x: 300 });
  });

  it("a right-edge grab pads rightward", () => {
    const box = centerLandsOnGrab(400, 60, 350, 30);
    expect(box).toMatchObject({ width: 700, x: 0 });
  });

  it("holds the invariant across the whole tile", () => {
    for (const gx of [0, 1, 133, 399.5, 400]) {
      for (const gy of [0, 12.25, 59, 60]) centerLandsOnGrab(400, 60, gx, gy);
    }
  });

  it("clamps a grab reported outside the raster to its edge", () => {
    centerLandsOnGrab(400, 60, -20, 75);
    expect(grabAlignedBox(400, 60, -20, 75)).toEqual(grabAlignedBox(400, 60, 0, 60));
  });

  it("never collapses to a zero-sized image", () => {
    expect(grabAlignedBox(0, 0, 0, 0)).toEqual({ width: 1, height: 1, x: 0, y: 0 });
  });
});
