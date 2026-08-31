/* The floating Full Disk Access panel — the window fdaGrantFlow.ts floats
   next to System Settings, laid out to match PermissionFlow's panel: a header
   ("Drag <app> to the list above to allow Full Disk Access.") with a wiggling
   up-arrow and a close button, over a drag card with the app icon, its name,
   and a small "Drag" hand hint. It renders only from main-held display data
   (name and icon); the drag payload — the bundle path — never enters this
   window, main starts the native drag. Close goes through main too: the
   window is non-focusable and main owns the flow's lifecycle. */
import { el, icon } from "./dom.js";

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
