/* The floating Full Disk Access panel — the window fdaGrantFlow.ts floats
   next to System Settings, laid out to match PermissionFlow's panel: a header
   ("Drag <app> to the list above to allow Full Disk Access.") with a wiggling
   up-arrow and a close button, over a drag card with the app icon, its name,
   and a small "Drag" hand hint. It renders only from main-held display data
   (name and icon); the drag payload — the bundle path — never enters this
   window, main starts the native drag. Close goes through main too: the
   window is non-focusable and main owns the flow's lifecycle. */
import { el } from "./dom.js";

/* Two glyphs PermissionFlow draws with SF Symbols, as local shapes the way
   dom.js draws everything (never innerHTML). */
const shapedIcon = (cls, fill, shapes) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("fill", fill ? "currentColor" : "none");
  if (!fill) {
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.6");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
  }
  for (const [tag, attrs] of shapes) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.appendChild(node);
  }
  return svg;
};
// arrowshape.up.fill
const arrowUp = () => shapedIcon("fda-arrow", true, [
  ["path", { d: "M12 2.5 L20.5 11.5 H15.5 V21 H8.5 V11.5 H3.5 Z" }],
]);
// hand.draw, simplified: a raised hand
const handDraw = () => shapedIcon("fda-hand", false, [
  ["path", { d: "M9 12V5a1.4 1.4 0 0 1 2.8 0v5.5" }],
  ["path", { d: "M11.8 10.5V4.4a1.4 1.4 0 0 1 2.8 0V11" }],
  ["path", { d: "M14.6 11V6.4a1.4 1.4 0 0 1 2.8 0v7.1c0 3.6-2.4 6-6 6h-.8c-2 0-3.6-.9-4.7-2.4l-2.3-3.3a1.7 1.7 0 0 1 2.7-2L9 14.5" }],
]);
// xmark.circle.fill
const closeGlyph = () => shapedIcon("fda-close-glyph", false, [
  ["path", { d: "M9 9l6 6M15 9l-6 6" }],
]);

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
const arrow = arrowUp();
const closeBtn = el("button", { class: "fda-close", attrs: { "aria-label": "Close", type: "button" } },
  [closeGlyph()]);
closeBtn.addEventListener("click", () => window.domo.fullDiskDismiss());

const card = el("div", { class: "fda-drag-tile", attrs: { draggable: "true" } }, [
  info ? el("img", { class: "fda-drag-icon", attrs: { src: info.iconDataUrl, alt: "" } }) : null,
  el("div", { class: "fda-drag-name", text: appName }),
  el("div", { class: "spacer" }),
  el("div", { class: "fda-drag-hint" }, [handDraw(), el("span", { text: "Drag" })]),
]);
// Pointer down takes a visibility hold so a frontmost flicker can't hide the
// panel mid-gesture (hiding the drag source aborts the drag). A plain click
// releases it on pointer up; when a drag actually starts, main releases it
// when the drag session ends — the DOM never sees that end, because dragstart
// is cancelled in favor of the native drag.
card.addEventListener("pointerdown", () => window.domo.fullDiskPanelHold(true));
card.addEventListener("pointerup", () => window.domo.fullDiskPanelHold(false));
card.addEventListener("dragstart", (e) => {
  e.preventDefault(); // main starts the native drag with the real payload
  window.domo.fullDiskDragStart();
});

root.replaceChildren(el("div", { class: "fda-panel" }, [
  el("div", { class: "fda-header" }, [arrow, headerText, el("div", { class: "spacer" }), closeBtn]),
  card,
]));

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
