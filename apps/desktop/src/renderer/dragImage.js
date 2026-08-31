/* Electron centers a native drag image on the cursor — there is no anchor
   parameter — so a tile grabbed near an edge would jump half the difference
   toward that edge the moment it lifts. The fix is geometric: pad the raster
   with transparency until the grab point IS the image's center, and the
   centered placement puts the tile exactly back under the pointer.

   Pure math, so the suite can hold it; fdapanel.js draws with it. */

/**
 * The padded box for a raster of `width`×`height` grabbed at (gx, gy):
 * `width`/`height` are the padded image's size, (x, y) is where the raster is
 * drawn inside it so the grab point lands dead center. All in the raster's
 * own units (CSS points); a grab outside the raster clamps to its edge.
 */
export function grabAlignedBox(width, height, gx, gy) {
  const cx = Math.min(Math.max(gx, 0), width);
  const cy = Math.min(Math.max(gy, 0), height);
  const halfW = Math.max(cx, width - cx);
  const halfH = Math.max(cy, height - cy);
  return {
    width: Math.max(1, 2 * halfW),
    height: Math.max(1, 2 * halfH),
    x: halfW - cx,
    y: halfH - cy,
  };
}
