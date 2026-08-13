/**
 * Dock-icon DEV ribbon for from-source runs. main.ts repoints the Dock at the
 * repo artwork, but that alone makes a dev run look identical to the packaged
 * install; stamping a diagonal ribbon over the icon makes the difference
 * visible at a glance.
 *
 * The main process has no drawing API, so the compositing runs in a hidden
 * sandboxed about:blank window: main.ts feeds this script to
 * executeJavaScript and hands the returned PNG data URL to app.dock.setIcon.
 * Only the script's construction can be tested headlessly (devIcon.test.ts):
 * the icon bytes and the label must land as string data, never as code.
 */

/**
 * Script that draws `pngBase64` on a canvas, stamps a diagonal `label` ribbon
 * across its top-right corner, and resolves to a PNG data URL.
 */
export function devIconScript(pngBase64: string, label: string): string {
  const src = JSON.stringify(`data:image/png;base64,${pngBase64}`);
  return `(async () => {
  const img = new Image();
  img.src = ${src};
  await img.decode();
  const size = img.naturalWidth;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext("2d");
  c.drawImage(img, 0, 0, size, size);
  // Paint only where the icon already has pixels, so the ribbon follows the
  // squircle's alpha instead of jutting into the transparent margins.
  c.globalCompositeOperation = "source-atop";
  c.translate(0.7 * size, 0.3 * size);
  c.rotate(Math.PI / 4);
  c.fillStyle = "rgba(196, 32, 32, 0.95)";
  c.fillRect(-size, -0.085 * size, 2 * size, 0.17 * size);
  c.fillStyle = "#ffffff";
  c.font = "700 " + Math.round(0.12 * size) + "px system-ui, sans-serif";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(${JSON.stringify(label)}, 0, 0);
  return canvas.toDataURL("image/png");
})()`;
}
