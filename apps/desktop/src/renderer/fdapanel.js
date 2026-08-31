/* The floating Full Disk Access panel — the window fdaGrantFlow.ts floats
   next to System Settings, laid out to match PermissionFlow's panel: a header
   ("Drag <app> to the list above to allow Full Disk Access.") with a wiggling
   up-arrow and a close button, over a drag card with the app icon, its name,
   and a small "Drag" hand hint. It renders only from main-held display data
   (name and icon); the drag payload — the bundle path — never enters this
   window, main starts the native drag. What does flow back is display data:
   a raster of the tile itself, so the dragged item looks like the tile
   picked up off the panel. Close goes through main too: the window is
   non-focusable and main owns the flow's lifecycle. */
import { el, icon } from "./dom.js";
import { grabAlignedBox } from "./dragImage.js";

const root = document.getElementById("root");
const info = await window.domo.fullDiskDragInfo();
const appName = info?.name ?? "this app";

// "Drag **<app>** to the list above to allow **Full Disk Access**."
const headerText = el("span", { class: "fda-header-text" }, [
  el("span", { text: "Drag " }),
  el("b", { text: appName }),
  el("span", { text: " to the list above to allow " }),
  el("b", { text: "Full Disk Access" }),
  el("span", { text: "." }),
]);
const arrow = icon("arrowUp", { class: "fda-arrow", fill: true });
const closeBtn = el("button", { class: "fda-close", attrs: { "aria-label": "Close", type: "button" } },
  [icon("close", { class: "fda-close-glyph", strokeWidth: "2.5" })]);
closeBtn.addEventListener("click", () => window.domo.fullDiskDismiss());

const card = el("div", { class: "fda-drag-tile", attrs: { draggable: "true" } }, [
  info ? el("img", { class: "fda-drag-icon", attrs: { src: info.iconDataUrl, alt: "" } }) : null,
  el("div", { class: "fda-drag-name", text: appName }),
  el("div", { class: "spacer" }),
  el("div", { class: "fda-drag-hint" }, [
    icon("hand", { class: "fda-hand", strokeWidth: "1.6" }),
    el("span", { text: "Drag" }),
  ]),
]);
// Pointer down takes a visibility hold so a frontmost flicker can't hide the
// panel mid-gesture (hiding the drag source aborts the drag). A plain click
// releases it on pointer up; when a drag actually starts, main releases it
// when the drag session ends — the DOM does see that end (main announces it,
// to bring the tile back), but the hold is main's to release either way.
card.addEventListener("pointerdown", (e) => {
  window.domo.fullDiskPanelHold(true);
  sendGrabAlignedTileImage(e);
});
card.addEventListener("pointerup", () => window.domo.fullDiskPanelHold(false));
card.addEventListener("dragstart", (e) => {
  e.preventDefault(); // main starts the native drag with the real payload
  // The drag image is this very tile (see sendTileImage), so the tile leaves
  // the panel with it — showing both would double it. Back on dragEnd.
  // Hide FIRST and only then let main begin the drag session: main's
  // startDrag runs a nested event loop, and a hide that hasn't reached the
  // screen by then stays un-painted for the whole ride. Two rAFs put the
  // start after the hidden frame is up (the first fires before that frame
  // paints, the second after); the timeout is the fallback clock so a
  // throttled rAF can never swallow the drag.
  card.classList.add("dragging");
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    window.domo.fullDiskDragStart();
  };
  requestAnimationFrame(() => requestAnimationFrame(start));
  setTimeout(start, 50);
});
window.domo.onFullDiskDragEnd(() => card.classList.remove("dragging"));

/* The drag image IS the tile. Rasterize the card exactly as it renders —
   computed styles inlined onto a clone, wrapped in an SVG foreignObject,
   drawn to a canvas at the display's scale — and hand the PNG to main, which
   uses it as the native drag image (falling back to the bare app icon if
   this never lands). Display data flowing out, like dragInfo flowing in;
   no path is involved. The raster is kept here too: Electron centers a drag
   image on the cursor, so pointerdown re-sends it padded per grabAlignedBox
   and the tile lifts off without shifting under the pointer. */
let tileRaster = null; // { canvas, width, height, scale } — CSS-point dims
function inlineComputedStyles(source, target) {
  const cs = getComputedStyle(source);
  for (const prop of cs) target.style.setProperty(prop, cs.getPropertyValue(prop));
  for (let i = 0; i < source.children.length; i++) {
    inlineComputedStyles(source.children[i], target.children[i]);
  }
}
async function sendTileImage() {
  try {
    const rect = card.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const clone = card.cloneNode(true);
    inlineComputedStyles(card, clone);
    clone.removeAttribute("draggable");
    clone.classList.remove("dragging");
    // The "Drag" hand hint stays on the panel's tile but not on the floating
    // image — an instruction to drag makes no sense on a thing already being
    // dragged. It must be display:none, not visibility:hidden: the inlining
    // pass stamped every child with its computed visibility:visible, which
    // would override the inherited hidden. Nothing shifts — the tile's own
    // computed width is inlined too. (After inlineComputedStyles, whose walk
    // needs the two trees to still match child-for-child.)
    const hint = clone.querySelector(".fda-drag-hint");
    if (hint) hint.style.display = "none";
    // On the panel the tile's translucent white sits over the panel's
    // near-opaque gray; flatten that stack so the floating tile keeps the
    // on-panel look instead of going see-through over System Settings.
    clone.style.background = "rgb(249, 249, 250)";
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}">` +
      `<foreignObject width="100%" height="100%">` +
      new XMLSerializer().serializeToString(clone) +
      `</foreignObject></svg>`;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    const scale = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(rect.width * scale);
    canvas.height = Math.round(rect.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    tileRaster = { canvas, width: rect.width, height: rect.height, scale };
    window.domo.fullDiskTileImage(canvas.toDataURL("image/png"), scale);
  } catch {
    // Main keeps the bare app icon as the drag image; the drag still works.
  }
}

/* Re-send the raster padded so the grab point is the image's center (see
   dragImage.js for why). Composed synchronously from the cached raster —
   no SVG decode — and the preload's sends share one ordered pipe, so this
   lands in main before the dragStart that follows it. */
function sendGrabAlignedTileImage(e) {
  const raster = tileRaster;
  if (!raster) return;
  try {
    const rect = card.getBoundingClientRect();
    const box = grabAlignedBox(
      raster.width, raster.height,
      e.clientX - rect.left, e.clientY - rect.top,
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(box.width * raster.scale);
    canvas.height = Math.round(box.height * raster.scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(raster.scale, raster.scale);
    ctx.drawImage(raster.canvas, box.x, box.y, raster.width, raster.height);
    window.domo.fullDiskTileImage(canvas.toDataURL("image/png"), raster.scale);
  } catch {
    // Main keeps the last raster it got — a centered grab is still exact.
  }
}
// The tile's width follows the panel's (main resizes it to track System
// Settings), so a fresh raster follows every settle.
let tileImageTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(tileImageTimer);
  tileImageTimer = setTimeout(() => void sendTileImage(), 150);
});

root.replaceChildren(el("div", { class: "fda-panel" }, [
  el("div", { class: "fda-header" }, [arrow, headerText, el("div", { class: "spacer" }), closeBtn]),
  card,
]));
// First raster once the icon is decoded, so the clone doesn't paint a blank
// square where the app icon goes.
const iconImg = card.querySelector("img");
void (iconImg?.decode() ?? Promise.resolve()).catch(() => {}).then(() => sendTileImage());

// The grant happens over in System Settings with no event back, so a fresh
// probe on a short clock repaints the header — main polls too and closes this
// window shortly after the grant lands.
const apply = (caps) => {
  if (!caps.fullDiskAccess) return;
  arrow.classList.add("granted");
  card.classList.add("granted");
  headerText.replaceChildren(
    el("b", { text: "Full Disk Access" }),
    el("span", { text: " granted." }),
  );
};
apply(await window.domo.capabilitiesGet());
setInterval(async () => apply(await window.domo.capabilitiesGet()), 1500);
