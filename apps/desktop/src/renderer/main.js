/* Main-window renderer. Sandboxed: no Node, no ipcRenderer — only the narrow
   `window.domo` bridge from preload. All agent-derived text is inserted with
   textContent (never innerHTML), so nothing on the wire can inject markup. */

import {
  PURPOSE_CAVEATS,
  PURPOSE_LABEL,
  PURPOSE_PLACEHOLDER,
} from "./approvals.js";

import { el, icon } from "./dom.js";
import { renderVault, vaultConfirmLeave } from "./vault.js";

const view = document.getElementById("view");
const seg = document.getElementById("seg");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

// Null until boot() picks one: the HTML marks Audit active for the first paint,
// but boot must still RENDER that pane, and "already on this tab" now returns
// early — so the starting value cannot be a tab boot might legitimately select.
let currentTab = null;
let filter = "all";
// The mounted Settings pane, while that tab is up. Holds a `refresh` that
// updates the display nodes in place, so a relay reconnect cannot reset the
// pane under someone reading it.
let settingsMounted = null;

/** The Discord mark. Built apart from `icon()`: that helper draws stroked
    line art, and this is a filled silhouette. */
function discordIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 127.14 96.36");
  svg.setAttribute("class", "discord-ico");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z");
  svg.appendChild(p);
  return svg;
}

/** The shared globe line art at the Support row's size. */
function globeIcon() {
  const svg = icon("browser");
  svg.setAttribute("class", "ico support-globe");
  return svg;
}

function badge(tone, text) {
  return el("span", { class: `badge b-${tone}` }, [el("span", { class: "dot" }), el("span", { text })]);
}

async function refreshStatus() {
  const status = await window.domo.statusGet();
  statusDot.className = "status-dot" + (status.connected ? " on" : "");
  statusText.textContent = status.connected ? `Connected · ${status.name}` : "Not connected";
}

// ---- Audit (master–detail, mockup Alternative 1) ----
// Rows are grouped ACTIVITIES (one logical operation), each with a per-event
// timeline in the detail pane — matching the Swift app's fine-grained view.

let selectedId = null;
let auditTopId = null; // id of the top (newest) row at the last refresh
let auditSearch = "";
let detailWidth = 340; // resizable detail pane width (px), kept across refreshes
// References to the mounted audit chrome, so typing in the search box refreshes
// only the list/detail (not the input itself → no focus loss).
let auditMounted = null;

// Mount the audit chrome once (search input, chips, list + detail containers).
async function renderAudit() {
  const search = el("div", { class: "search" }, [
    el("input", { attrs: { placeholder: "Search activity, path, agent…" } }),
  ]);
  const searchInput = search.querySelector("input");
  searchInput.value = auditSearch;
  searchInput.addEventListener("input", () => { auditSearch = searchInput.value; refreshAudit(); });

  const chipsBox = el("div", { class: "chips" });
  const count = el("span", { class: "count" });
  const clearBtn = el("button", { class: "btn small", text: "Clear Log" });
  clearBtn.addEventListener("click", async () => {
    const cleared = await window.domo.auditClear();
    if (cleared) { selectedId = null; refreshAudit(); }
  });
  const toolbar = el("div", { class: "toolbar" }, [
    search, chipsBox, el("div", { class: "spacer" }), count, clearBtn,
  ]);

  const listBox = el("div", { class: "list" });
  // The detail pane is a column: the activity info scrolls in .detail-scroll;
  // the live browser thumbnail sits pinned below it, outside the scroll.
  const detailScroll = el("div", { class: "detail-scroll" });
  const liveImg = el("img", { attrs: { alt: "Live browser view" } });
  const liveDot = el("span", { class: "dot" });
  const liveCapText = el("span");
  const liveBox = el("div", { class: "live-corner hidden" }, [
    liveImg,
    el("div", { class: "live-cap" }, [liveDot, liveCapText]),
  ]);
  const detailBox = el("aside", { class: "detail" }, [detailScroll, liveBox]);
  detailBox.style.width = detailWidth + "px";
  const splitter = el("div", { class: "splitter", attrs: { title: "Drag to resize" } });
  wireSplitter(splitter, detailBox);
  view.replaceChildren(toolbar, el("div", { class: "a1" }, [listBox, splitter, detailBox]));

  // The table (and its tbody) persist across refreshes so row nodes are reused,
  // not rebuilt — that keeps an in-progress insert animation alive and lets a
  // burst of streamed events update a row in place instead of recreating it.
  const tbody = el("tbody");
  const table = el("table", {}, [
    el("thead", {}, [el("tr", {}, [
      el("th", { text: "Time" }), el("th", { text: "Status" }), el("th", { text: "Activity" }),
    ])]),
    tbody,
  ]);

  auditMounted = {
    listBox, detailScroll, count, chipsBox, clearBtn, table, tbody, rows: new Map(),
    liveBox, liveImg, liveDot, liveCapText, liveHasFrame: false,
  };
  await refreshAudit();
  refreshLiveThumb();
  searchInput.focus();
  const len = searchInput.value.length;
  searchInput.setSelectionRange(len, len);
}

// Drag the splitter to resize the detail pane (dragging left widens it).
function wireSplitter(splitter, detailBox) {
  splitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = detailWidth;
    const onMove = (ev) => {
      const w = startW + (startX - ev.clientX);
      detailWidth = Math.max(240, Math.min(w, window.innerWidth - 360));
      detailBox.style.width = detailWidth + "px";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
  });
}

// Refresh just the data-bound parts — leaves the search input untouched.
// `opts.followTop` (set on live data changes) moves the selection to the new
// newest row when it was pinned to the top, so streaming activity stays in view.
async function refreshAudit(opts = {}) {
  if (!auditMounted) return;
  const { listBox, detailScroll, count, chipsBox, clearBtn, table, tbody, rows } = auditMounted;
  const activities = await window.domo.auditActivities();
  clearBtn.disabled = activities.length === 0;
  const q = auditSearch.trim().toLowerCase();
  const shown = activities.filter((a) => {
    const inCat = filter === "all" || a.category === filter;
    const inSearch =
      !q ||
      [a.title, a.command || "", a.agentDisplay || "", a.agentId || "", a.goal || ""]
        .join(" ")
        .toLowerCase()
        .includes(q);
    return inCat && inSearch;
  });
  // Selection: on a live data change, if the selection was pinned to the top
  // (newest) row, follow the new newest row so it keeps streaming into view.
  // Otherwise keep the same item, falling back to the newest if it's gone.
  const newTopId = shown[0] ? shown[0].id : null;
  if (opts.followTop && selectedId !== null && selectedId === auditTopId) {
    selectedId = newTopId;
  } else {
    selectedId = shown.some((a) => a.id === selectedId) ? selectedId : newTopId;
  }
  auditTopId = newTopId;
  const selected = shown.find((a) => a.id === selectedId) || null;

  chipsBox.replaceChildren(...["all", "approved", "denied", "failed", "other"].map((f) => {
    const chip = el("span", { class: "chip" + (filter === f ? " active" : ""), text: f[0].toUpperCase() + f.slice(1) });
    chip.addEventListener("click", () => { filter = f; refreshAudit(); });
    return chip;
  }));
  count.textContent = `${shown.length} ${shown.length === 1 ? "activity" : "activities"}`;

  // Empty state — no rows to reconcile; drop any cached row nodes.
  if (!shown.length) {
    rows.clear();
    tbody.replaceChildren();
    listBox.replaceChildren(el("div", { class: "empty", text: q || filter !== "all" ? "No matching activity." : "No activity yet." }));
    detailScroll.replaceChildren(detailFor(selected));
    return;
  }
  if (listBox.firstChild !== table) listBox.replaceChildren(table);

  // Only animate genuinely new rows arriving on a live data change (not on first
  // mount, tab switch, search, or filter — those would animate the whole list).
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animateNew = !!opts.followTop && !reduceMotion;
  const enterRows = [];

  // Drop rows that are no longer shown.
  const wantedIds = new Set(shown.map((a) => a.id));
  for (const [id, r] of rows) {
    if (!wantedIds.has(id)) { r.tr.remove(); rows.delete(id); }
  }

  // Create/update each row, reusing existing nodes so animations survive.
  shown.forEach((a) => {
    let r = rows.get(a.id);
    if (!r) {
      r = createAuditRow(a.id);
      rows.set(a.id, r);
      if (animateNew) enterRows.push(r.tr);
    }
    updateAuditRow(r, a);
    r.tr.classList.toggle("sel", a.id === selectedId);
  });

  // Put the rows in the desired (newest-first) order with minimal DOM moves, so
  // nodes that don't move keep their running animations undisturbed.
  let expected = tbody.firstChild;
  for (const a of shown) {
    const node = rows.get(a.id).tr;
    if (node === expected) expected = node.nextSibling;
    else tbody.insertBefore(node, expected);
  }

  detailScroll.replaceChildren(detailFor(selected));

  // Rows are in the DOM now (natural size measurable) — play the insert
  // animation for any freshly arrived rows.
  enterRows.forEach(animateRowEnter);
}

// ---- Live browser thumbnail ----
// While an agent has a browsing session open, a small near-live view of the
// Camoufox browser sits pinned in the detail pane's bottom-right corner —
// outside the timeline scroll, so it stays put. Polls the whole viewer state
// about once a second; between frames (or while the browser is mid-action) the
// last image simply stays. Frames are for the owner's eyes and are shown even
// when the page is out of the approved scope — that state is flagged red.

let liveThumbBusy = false;

async function refreshLiveThumb() {
  if (liveThumbBusy || currentTab !== "audit" || !auditMounted) return;
  liveThumbBusy = true;
  try {
    const s = await window.domo.viewerState();
    const m = auditMounted;
    if (!m) return;
    if (!s.active) m.liveHasFrame = false; // next session starts with a fresh frame
    if (s.active && s.frame && /^image\/(jpeg|png|webp)$/.test(s.frame.mime)) {
      m.liveImg.src = `data:${s.frame.mime};base64,${s.frame.dataB64}`;
      m.liveHasFrame = true;
    }
    m.liveBox.classList.toggle("hidden", !(s.active && m.liveHasFrame));
    m.liveBox.classList.toggle("offscope", s.active && !s.inScope);
    if (s.active) {
      m.liveCapText.textContent = s.inScope ? hostOf(s.url) || "Live" : "Out of approved scope";
      m.liveImg.title = s.url; // full URL on hover; the caption shows the host
    }
  } catch {
    /* main is busy — keep the last render */
  } finally {
    liveThumbBusy = false;
  }
}
setInterval(refreshLiveThumb, 1000);

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// Build a reusable audit row. Cell content is wrapped in a `.cw` so a new row
// can collapse to zero (a real table row won't shrink below its content) and
// grow to push the rows below it down. Content is later updated IN PLACE so a
// burst of streamed events never recreates (and thus never interrupts) the row.
function createAuditRow(id) {
  const timeCw = el("div", { class: "cw" });
  const badgeCw = el("div", { class: "cw" });
  const iconWrap = el("span", { class: "ic-wrap" });
  const titleSpan = el("span", { class: "t-title" });
  const actCw = el("div", { class: "cw" }, [el("div", { class: "t-act" }, [iconWrap, titleSpan])]);
  const tr = el("tr", {}, [
    el("td", { class: "t-time" }, [timeCw]),
    el("td", {}, [badgeCw]),
    el("td", {}, [actCw]),
  ]);
  // Select on mouse down (feels immediate, before the click completes).
  tr.addEventListener("mousedown", () => { selectedId = id; refreshAudit(); });
  return { tr, timeCw, badgeCw, iconWrap, titleSpan, time: null, tone: null, status: null, title: null, kind: null };
}

// Update a row's content in place, touching only what changed.
function updateAuditRow(r, a) {
  if (r.time !== a.time) { r.timeCw.textContent = a.time; r.time = a.time; }
  if (r.tone !== a.tone || r.status !== a.status) {
    r.badgeCw.replaceChildren(badge(a.tone, a.status));
    r.tone = a.tone; r.status = a.status;
  }
  if (r.kind !== a.kind) { r.iconWrap.replaceChildren(icon(a.kind)); r.kind = a.kind; }
  if (r.title !== a.title) { r.titleSpan.textContent = a.title; r.title = a.title; }
}

// Insert animation: the row collapses to zero and grows (pushing the rows below
// it down), then its content fades in once the push has mostly settled.
function animateRowEnter(tr) {
  const push = 260;
  const ease = "cubic-bezier(0.22, 1, 0.36, 1)";
  for (const td of tr.children) {
    const cs = getComputedStyle(td);
    const pt = cs.paddingTop;
    const pb = cs.paddingBottom;
    td.animate(
      [{ paddingTop: "0px", paddingBottom: "0px" }, { paddingTop: pt, paddingBottom: pb }],
      { duration: push, easing: ease },
    );
    const cw = td.firstElementChild;
    if (!cw) continue;
    const h = cw.offsetHeight;
    cw.style.overflow = "hidden";
    const grow = cw.animate(
      [{ height: "0px" }, { height: h + "px" }],
      { duration: push, easing: ease },
    );
    grow.onfinish = () => { cw.style.overflow = ""; };
    // Fade the content in after the push is ~70% done.
    cw.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 200, delay: push * 0.7, easing: "ease-out", fill: "backwards" },
    );
  }
}

function detailFor(a) {
  if (!a) return el("div", { class: "empty", text: "Select an activity." });

  const meta = el("dl", { class: "meta" });
  const addMeta = (k, v, mono) => {
    if (v === null || v === undefined || v === "") return;
    meta.appendChild(el("dt", { text: k }));
    meta.appendChild(el("dd", { class: mono ? "mono faint" : "", text: String(v) }));
  };
  addMeta("Agent", a.agentDisplay ? `${a.agentDisplay}  ${a.agentId || ""}`.trim() : a.agentId, !a.agentDisplay);
  addMeta("Goal", a.goal);
  addMeta("Decided by", a.decidedBy);
  addMeta("Intent", a.intentId, true);
  if (a.exitCode !== null && a.exitCode !== undefined) addMeta("Exit", a.exitCode);

  const children = [
    el("h3", {}, [badge(a.tone, a.status)]),
    a.command ? el("div", { class: "cmd", text: a.command }) : null,
    meta,
  ];
  if (a.capabilities && a.capabilities.length) {
    children.push(el("div", { class: "section-label", text: "Approved capability bounds" }));
    children.push(el("div", { class: "capchips" }, a.capabilities.map((c) => el("span", { class: "cap", text: String(c) }))));
  }
  if (a.timeline && a.timeline.length) {
    children.push(el("div", { class: "section-label", text: "Timeline" }));
    children.push(el("div", { class: "timeline" }, a.timeline.map((s) =>
      el("div", { class: "tl" + (s.state === "ok" ? " ok" : s.state === "bad" ? " bad" : "") }, [
        el("div", { class: "tt", text: s.text }),
        el("div", { class: "tm", text: s.time }),
      ]),
    )));
  }
  return el("div", {}, children.filter(Boolean));
}

// ---- Rules ----

async function renderRules() {
  const rules = await window.domo.rulesList();

  const ruleItems = rules.length
    ? rules.map((r) => {
        const remove = el("button", { class: "btn danger", text: "Revoke Rule" });
        remove.addEventListener("click", async () => { await window.domo.rulesRemove(r.ruleKey); renderRules(); });
        const caps = (r.capabilities || []).map((c) => el("span", { class: "cap", text: capText(c) }));
        return el("div", { class: "item" }, [
          el("div", { class: "row" }, [el("h4", { text: r.agentDisplay || r.agentId }), el("div", { class: "spacer" }), remove]),
          el("div", { class: "capchips" }, caps),
        ]);
      })
    : [el("div", { class: "empty", text: "No always-allow rules." })];

  view.replaceChildren(el("div", { class: "panel" }, [
    el("div", { class: "section-label", text: "Always-allow rules" }),
    ...ruleItems,
  ]));
}

// ---- Connect a client ----
//
// Screens 2–4 of the design: the URL, what to do with it, and the fallback for
// a client that cannot do OAuth. The main process owns the state; every call
// returns the whole of it and this just draws it.

/** A value the user must copy, with the button that does it. Shared shape with
    the setup window — same `.copyrow`/`.copybox` styles. */
function copyRow(value, label) {
  const box = el("div", { class: "copybox mono", text: value });
  const copy = el("button", { class: "btn small", text: label ?? "Copy" });
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(value);
    copy.textContent = "Copied";
    setTimeout(() => { copy.textContent = label ?? "Copy"; }, 1200);
  });
  return el("div", { class: "copyrow" }, [box, copy]);
}

/**
 * A shortcut into one client's connector setup, opened in the user's real
 * browser — the place the URL above gets pasted.
 *
 * A card exists only for a client whose link lands the user where they paste;
 * see `EXTERNAL_URLS` in main.ts. It is a shortcut past the clicks, not
 * the supported-client list — the group's subtitle names the others.
 *
 * From the designer's mock, minus the brand logo: an approximated or borrowed
 * mark is worse than none, so this is the label and the mock's ↗ until real
 * assets arrive.
 */
function clientCard(key, label) {
  const card = el("button", { class: "client-card" }, [
    el("span", { class: "client-name", text: label }),
    extArrow(),
  ]);
  card.addEventListener("click", () => window.domo.openExternal(key));
  return card;
}

/** The external-link ↗, for buttons whose click IS the action — it just
    happens in the browser. Hand-offs the user must still finish in another
    app (System Settings, Messages) take the macOS ellipsis in their label
    instead: "…" means more input needed, ↗ means it happens somewhere else. */
function extArrow() {
  return el("span", { class: "ext-arrow", text: "↗" });
}

/** A plain button that opens a web destination: the label, then the ↗. */
function externalBtn(label, key) {
  const btn = el("button", { class: "btn" }, [el("span", { text: label }), extArrow()]);
  btn.addEventListener("click", () => window.domo.openExternal(key));
  return btn;
}

/** One titled card: a prominent title, an optional description, then the body.
    Shared by Settings' groups and the Agents pane, which is one of them. */
function group(title, desc, body) {
  return el("div", { class: "item" }, [
    el("div", { class: "group-title", text: title }),
    desc ? el("p", { class: "faint group-desc", text: desc }) : null,
    ...body,
  ]);
}

/** Whether the static-credential modal is up. Renderer-local: it is a
    disclosure, not app state, and nothing outside this window cares. */
let staticOpen = false;

/** The one modal shell mounted outside the inert application chrome. */
let activeModal = null;

function closeModal(modal) {
  if (!modal || modal !== activeModal) return;
  document.removeEventListener("keydown", modal.onKeydown, true);
  modal.backdrop.remove();
  for (const node of document.querySelectorAll(".titlebar, #view, .update-banner")) {
    node.removeAttribute("inert");
  }
  activeModal = null;
  if (modal.trigger?.isConnected) modal.trigger.focus();
}

function openModal(trigger, { children = [], className = "", focus, canDismiss, onDismiss }) {
  if (activeModal) return null;
  const panel = el("div", {
    class: `modal${className ? ` ${className}` : ""}`,
    attrs: { role: "dialog", "aria-modal": "true" },
  }, children);
  const backdrop = el("div", { class: "modal-backdrop" }, [panel]);
  const dismiss = () => {
    if (canDismiss && !canDismiss()) return;
    onDismiss();
  };
  const onKeydown = (e) => {
    if (e.key !== "Escape" || (canDismiss && !canDismiss())) return;
    e.preventDefault();
    e.stopPropagation();
    onDismiss();
  };
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) dismiss();
  });
  document.addEventListener("keydown", onKeydown, true);
  for (const node of document.querySelectorAll(".titlebar, #view, .update-banner")) {
    node.setAttribute("inert", "");
  }
  document.body.appendChild(backdrop);
  activeModal = { backdrop, panel, trigger, onKeydown };
  (focus ?? panel.querySelector("button, input, select"))?.focus();
  return activeModal;
}

/**
 * The static-credential modal, while it is up.
 *
 * Lives on `document.body`, not inside `#view`: the pane behind it is made
 * `inert` while it is open, and a dialog nested inside the thing it disables
 * would disable itself.
 *
 * `nameInput` is held here and reused across refreshes: a relay reconnect can
 * redraw this while someone is halfway through typing a name, and rebuilding
 * the field would take the name with it.
 */
let staticModal = null;

/** Everything the modal switched off, switched back on. */
function closeStaticModal() {
  if (!staticModal) return;
  closeModal(staticModal);
  staticModal = null;
}

/**
 * Open the modal over the Agents pane.
 *
 * **The shown-once credential is the hazard here.** Once minted, the token is
 * in this modal and nowhere else — the app never wrote it down and the server
 * will not hand it back — and `connectDismiss` destroys that only copy. So the
 * escapes that are ordinary courtesies while the form is up (Esc, a click on
 * the backdrop, Cancel) are all refused once a credential is displayed: the
 * ONLY way out of that state is the explicit "I've Saved It", which is the
 * button that does the destroying and says so. A modal that vanished on a
 * stray Esc and took a live credential with it would be a data-loss bug with a
 * polite name.
 */
function openStaticModal(trigger, redraw) {
  const nameInput = el("input", { class: "text", attrs: { placeholder: "Claude Code" } });
  const shell = openModal(trigger, {
    focus: nameInput,
    // Esc and the backdrop close the form, but not a displayed credential.
    canDismiss: () => !staticModal?.holdingCredential,
    onDismiss: () => {
      staticOpen = false;
      closeStaticModal();
      redraw();
    },
  });
  if (!shell) return;
  staticModal = Object.assign(shell, { nameInput, kind: null, holdingCredential: false });
}

/**
 * Draw the modal from the same state the pane draws from.
 *
 * Rebuilds the panel only when the KIND changes (form → credential); within a
 * kind it updates the note and the disabled flags in place, so `nameInput`
 * survives every refresh that is not a state change.
 */
function syncStaticModal(s, redraw) {
  if (!staticModal) return;
  staticModal.holdingCredential = !!s.credential;
  const kind = s.credential ? "credential" : "form";
  const note =
    staticModal.note ?? el("p", { class: "faint modal-note", text: "" });
  staticModal.note = note;
  note.textContent = s.busy ? "Talking to Plow…" : (s.message ?? "");

  if (staticModal.kind !== kind) {
    staticModal.kind = kind;
    if (kind === "credential") {
      const done = el("button", { class: "btn primary", text: "I've Saved It" });
      done.addEventListener("click", async () => {
        await window.domo.connectDismiss();
        staticOpen = false;
        closeStaticModal();
        redraw();
      });
      staticModal.panel.replaceChildren(
        el("div", { class: "group-title", text: `Paste this into ${s.credential.name}` }),
        el("p", { class: "warn conn-note", text: "Copy it now — it is shown once and cannot be shown again. Saving it is the only way to close this." }),
        copyRow(s.credential.config, "Copy Config"),
        note,
        el("div", { class: "row conn-actions" }, [el("div", { class: "spacer" }), done]),
      );
      done.focus();
    } else {
      const create = async () => {
        await window.domo.connectCreate(staticModal.nameInput.value);
        redraw();
      };
      staticModal.nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") create();
      });
      const createBtn = el("button", { class: "btn primary", text: "Create Credential" });
      createBtn.addEventListener("click", create);
      const cancel = el("button", { class: "btn", text: "Cancel" });
      cancel.addEventListener("click", () => {
        staticOpen = false;
        closeStaticModal();
        redraw();
      });
      staticModal.actions = [cancel, createBtn];
      staticModal.panel.replaceChildren(
        el("div", { class: "group-title", text: "Static credential" }),
        el("p", {
          class: "faint conn-note",
          text: "For a client that can't do OAuth. It is long-lived, shown once, and can be revoked from your Plow account.",
        }),
        el("div", { class: "field" }, [el("label", { text: "Name this connection" }), staticModal.nameInput]),
        note,
        el("div", { class: "row conn-actions" }, [cancel, el("div", { class: "spacer" }), createBtn]),
      );
      staticModal.nameInput.focus();
    }
  }
  // In-place, every refresh: the field is never rebuilt, so nothing typed is
  // ever taken away by one.
  staticModal.nameInput.disabled = !!s.busy;
  for (const b of staticModal.panel.querySelectorAll("button")) b.disabled = !!s.busy;
}

/**
 * The body of the "Connect a client" settings group — the FIRST group on the
 * pane, above the account it depends on: connecting a client is the thing you
 * come here to do, and burying it under the account read as optional.
 *
 * Returns nodes instead of painting the view: it is no longer a screen of its
 * own, and `redraw` repaints only this group rather than the pane around it.
 */
function connectNodes(s, redraw) {
  // Not signed in should be unreachable — the gate means the main window does
  // not exist without a credential — but showing a blank URL would be worse
  // than saying so. Folded in rather than early-returning off the screen: this
  // is a group that renders in both states.
  if (!s.hasCredential) {
    return [
      el("p", { class: "faint conn-note", text: "Sign in below — a client reaches this Mac through your Plow account." }),
    ];
  }

  // Only when the modal is closed: while it is up, its own note says this, and
  // the same sentence behind an overlay is noise.
  const note =
    staticModal || !(s.busy || s.message)
      ? null
      : el("p", { class: "faint", text: s.busy ? "Talking to Plow…" : s.message });

  // The alternative to the whole flow, behind a quiet link. It opens a MODAL
  // rather than expanding in place: the form is the heaviest thing this pane
  // can show, and inline it out-shouted the OAuth path it is the fallback to.
  let fallback = [];
  if (!s.credential) {
    const link = el("button", { class: "linkbtn", text: "Can't use OAuth? Create a static credential" });
    link.addEventListener("click", () => {
      staticOpen = true;
      openStaticModal(link, redraw);
      redraw();
    });
    fallback = [el("div", { class: "alt" }, [link])];
  }

  // One flow, not a checklist: copy the URL, paste it in your client, done.
  // Signing in is NOT a step — it is what the client does on first connect, so
  // it is said once as reassurance in the same breath as the paste, and never
  // as an instruction to carry out. The static credential comes last because it
  // is the alternative to all of this, not the end of it.
  const box = el("div", { class: "connect" }, [
    copyRow(s.mcpUrl || "—"),
    el("p", {
      class: "faint flow-note",
      text: "Paste it into your client's custom MCP server setting. Your client signs in with OAuth the first time it connects — no token to copy, store, or rotate.",
    }),
    // One card. The mock's two-up grid is not kept for a single card — a
    // half-empty grid reads as a tile that failed to load.
    el("div", { class: "client-cards" }, [clientCard("claude", "Open Claude")]),
    ...fallback,
    note,
  ].filter(Boolean));

  // Scoped to this subsection: the account rows above it (Sign Out) are not
  // this subsection's to disable while it is mid-call.
  for (const b of box.querySelectorAll("button")) if (s.busy) b.disabled = true;
  return [box];
}

// ---- Cloud agents ---------------------------------------------------------

/** The cloud-agent dialog, if one is open. It lives outside #view so a state
    refresh can redraw the roster without taking an in-progress choice away. */
let cloudModal = null;

function closeCloudModal() {
  if (!cloudModal) return;
  closeModal(cloudModal);
  cloudModal = null;
}

/** A modal for an ordinary, reversible cloud action. */
function openCloudModal(trigger, children, focus) {
  const shell = openModal(trigger, {
    children,
    className: "cloud-modal",
    focus,
    onDismiss: closeCloudModal,
  });
  if (!shell) return null;
  cloudModal = shell;
  return shell.panel;
}

function cloudStatus(status) {
  if (status === "running") return { tone: "green", label: "Ready" };
  if (status === "provisioning") return { tone: "amber", label: "Setting up…" };
  if (status === "teardown") return { tone: "amber", label: "Removing…" };
  return { tone: "amber", label: status || "Status unavailable" };
}

function cloudProvider(provider) {
  if (!provider) return "Provider unavailable";
  return provider[0].toUpperCase() + provider.slice(1);
}

function cloudCreated(createdAt) {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? "" : `Created ${date.toLocaleDateString()}`;
}

const pendingCloudCreates = new Map();
let pendingCloudCreateId = 0;

function visibleCloudAgents(state) {
  const serverChats = new Set(state.cloudAgents.map((agent) => agent.chatUid));
  return [
    ...[...pendingCloudCreates.values()].filter((agent) => !serverChats.has(agent.chatUid)),
    ...state.cloudAgents,
  ];
}

function openCloudPicker(trigger, state, redraw) {
  const newChatValue = "__new_chat__";
  const select = el("select", { class: "text", attrs: { "aria-label": "Chat" } },
    [
      ...state.cloudChats.map((chat) => el("option", { text: chat.label, attrs: { value: chat.uid } })),
      el("option", { text: "New chat…", attrs: { value: newChatValue } }),
    ],
  );
  const name = el("input", { class: "text", attrs: { placeholder: "Cloud agent", "aria-label": "Agent name" } });
  const warning = el("div", { class: "cloud-warning" }, [
    el("div", { class: "warn cloud-warning-title", text: "This changes the chat permanently" }),
    el("p", {
      class: "faint",
      text: "This agent will take over notifications for the selected chat. Removing the agent later will not restore them.",
    }),
  ]);
  const syncWarning = () => {
    warning.hidden = select.value === newChatValue ||
      visibleCloudAgents(state).some((agent) => agent.chatUid === select.value);
  };

  const cancel = el("button", { class: "btn", text: "Cancel" });
  cancel.addEventListener("click", closeCloudModal);
  const create = el("button", { class: "btn primary", text: "Set up agent" });
  create.addEventListener("click", async () => {
    if (!select.value) return;
    if (select.value === newChatValue) {
      showExplainer();
      return;
    }
    create.disabled = true;
    cancel.disabled = true;
    create.replaceChildren(
      el("span", { class: "cloud-spinner", attrs: { "aria-hidden": "true" } }),
      el("span", { text: "Setting up…" }),
    );
    const chatUid = select.value;
    const requestedName = name.value.trim();
    const chat = state.cloudChats.find((option) => option.uid === chatUid);
    const pendingId = `pending-cloud-${++pendingCloudCreateId}`;
    pendingCloudCreates.set(pendingId, {
      agentId: pendingId,
      name: requestedName || "Cloud agent",
      chatUid,
      chatLabel: chat?.label || chatUid,
      provider: "",
      status: "provisioning",
      failureReason: null,
      createdAt: "",
      localPending: true,
    });
    const request = window.domo.cloudCreate(chatUid, requestedName);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    closeCloudModal();
    await redraw();
    try {
      await request;
    } finally {
      pendingCloudCreates.delete(pendingId);
      await redraw();
    }
  });
  const pickerChildren = [
    el("div", { class: "group-title", text: "Set up a cloud agent" }),
    el("p", { class: "faint conn-note", text: "Choose the chat where this agent will read and reply." }),
    el("div", { class: "field" }, [el("label", { text: "Chat" }), select]),
    el("div", { class: "field" }, [el("label", { text: "Name (optional)" }), name]),
    warning,
    el("div", { class: "row cloud-modal-actions" }, [cancel, el("div", { class: "spacer" }), create]),
  ];
  let panel = null;
  const showPicker = () => {
    if (!panel) return;
    panel.replaceChildren(...pickerChildren);
    syncWarning();
    select.focus();
  };
  const showExplainer = () => {
    if (!panel) return;
    const back = el("button", { class: "btn", text: "Back" });
    back.addEventListener("click", showPicker);
    const verify = el("button", { class: "btn primary", text: "Verify a new Plow number" });
    verify.addEventListener("click", async () => {
      closeCloudModal();
      await window.domo.onboardingOpen();
    });
    const number = state.cloudSendTo
      ? el("p", { class: "cloud-route-number" }, [
          document.createTextNode("Number to text: "),
          el("span", { class: "mono", text: state.cloudSendTo }),
        ])
      : null;
    panel.replaceChildren(
      el("div", { class: "group-title", text: "Create a new chat" }),
      el("p", { class: "faint conn-note", text: "There are two ways to make another chat available here." }),
      el("div", { class: "cloud-route" }, [
        el("div", { class: "cloud-route-title", text: "Verify a new Plow number" }),
        el("p", { class: "faint", text: "Run activation again, then text the code to the number Plow provides." }),
        number,
        verify,
      ]),
      el("div", { class: "cloud-route" }, [
        el("div", { class: "cloud-route-title", text: "Start a group thread" }),
        el("p", {
          class: "faint",
          text: "Add a verified Plow number to a group thread with other people. The chat appears here once someone speaks.",
        }),
      ]),
      el("div", { class: "row cloud-modal-actions" }, [back]),
    );
    back.focus();
  };
  select.addEventListener("change", () => {
    if (select.value === newChatValue) showExplainer();
    else syncWarning();
  });
  panel = openCloudModal(trigger, pickerChildren, select);
  if (!panel) return;
  syncWarning();
}

function openCloudSettings(trigger, agent, state, redraw) {
  const stored = state.cloudAgentSettings?.[agent.agentId];
  const review = el("input", { attrs: { type: "checkbox" } });
  review.checked = stored?.adversarialReview === true;
  const cancel = el("button", { class: "btn", text: "Cancel" });
  cancel.addEventListener("click", closeCloudModal);
  const apply = el("button", { class: "btn primary", text: "Apply changes" });
  apply.addEventListener("click", async () => {
    review.disabled = true;
    apply.disabled = true;
    try {
      await window.domo.cloudApply(agent.agentId, {
        adversarialReview: review.checked,
      });
      closeCloudModal();
      await redraw();
    } finally {
      if (review.isConnected) review.disabled = false;
      if (apply.isConnected) apply.disabled = false;
    }
  });
  openCloudModal(trigger, [
    el("div", { class: "group-title", text: `${agent.name} settings` }),
    el("div", { class: "cloud-local-settings" }, [
      el("label", { class: "check block cloud-setting" }, [
        review,
        el("span", {}, [
          el("span", { class: "cloud-setting-title", text: "Adversarial review" }),
          el("span", { class: "faint cloud-setting-copy", text: "Have Latch review this agent's requests before they run on this Mac." }),
        ]),
      ]),
      el("p", { class: "faint cloud-local-note", text: "Stored on this Mac and applies immediately." }),
    ]),
    el("div", { class: "row cloud-modal-actions" }, [cancel, el("div", { class: "spacer" }), apply]),
  ], review);
}

function openCloudRemove(trigger, agent, redraw) {
  const cancel = el("button", { class: "btn", text: "Cancel" });
  cancel.addEventListener("click", closeCloudModal);
  const remove = el("button", { class: "btn danger", text: "Remove agent" });
  remove.addEventListener("click", async () => {
    remove.disabled = true;
    cancel.disabled = true;
    await window.domo.cloudDelete(agent.agentId);
    closeCloudModal();
    await redraw();
  });
  openCloudModal(trigger, [
    el("div", { class: "group-title", text: `Remove ${agent.name}?` }),
    el("p", {
      class: "faint conn-note",
      text: "The agent will stop reading and replying in this chat. The chat's previous notification setup cannot be restored.",
    }),
    el("div", { class: "row cloud-modal-actions" }, [cancel, el("div", { class: "spacer" }), remove]),
  ], cancel);
}

function cloudAgentRow(agent, state, redraw) {
  const status = cloudStatus(agent.status);
  const settings = el("button", { class: "btn small", text: "Settings" });
  settings.addEventListener("click", () => openCloudSettings(settings, agent, state, redraw));
  const remove = el("button", { class: "btn small danger", text: "Remove" });
  remove.addEventListener("click", () => openCloudRemove(remove, agent, redraw));
  settings.disabled = !!agent.localPending;
  remove.disabled = !!agent.localPending;
  const actions = [settings, remove];
  const details = [
    agent.chatLabel,
    agent.localPending ? null : cloudProvider(agent.provider),
    cloudCreated(agent.createdAt),
  ].filter(Boolean);
  return el("div", { class: `item cloud-agent-row cloud-${agent.status}`, attrs: { "data-cloud-agent-id": agent.agentId } }, [
    el("div", { class: "row cloud-agent-heading" }, [
      el("div", { class: "cloud-agent-name", text: agent.name }),
      badge(status.tone, status.label),
      el("div", { class: "spacer" }),
      el("div", { class: "row cloud-agent-actions" }, actions),
    ]),
    el("p", { class: "cloud-agent-meta", text: details.join(" · ") }),
    agent.status === "provisioning"
      ? el("div", { class: "cloud-progress" }, [
          el("span", { class: "cloud-spinner", attrs: { "aria-hidden": "true" } }),
          el("span", { text: "Setting up your agent — this takes a minute or two." }),
        ])
      : null,
  ]);
}

function cloudAgentList(state, redraw) {
  const agents = visibleCloudAgents(state);
  if (!agents.length) return null;
  return el("div", { class: "cloud-agent-list" }, agents.map((agent) =>
    cloudAgentRow(agent, state, redraw),
  ));
}

const cloudHttpReasons = new Set([
  "bad request",
  "unauthorized",
  "forbidden",
  "not found",
  "method not allowed",
  "not acceptable",
  "request timeout",
  "conflict",
  "gone",
  "unprocessable entity",
  "too many requests",
  "internal server error",
  "not implemented",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
]);

function cloudErrorCopy(message) {
  const reason = String(message ?? "").trim().replace(/[.!]$/, "").toLowerCase();
  if (cloudHttpReasons.has(reason) || /^(?:plow returned|http(?: error)?) \d{3}$/.test(reason)) {
    return "Plow couldn't complete that request. Try again.";
  }
  return message;
}

function cloudErrorBanner(message, title = "Cloud agents could not be refreshed") {
  if (!message) return null;
  return el("div", { class: "cloud-callout cloud-error" }, [
    el("div", { class: "cloud-callout-title", text: title }),
    el("p", { class: "faint", text: cloudErrorCopy(message) }),
  ]);
}

function cloudNodes(state, redraw) {
  const action = el("div", { class: "row cloud-toolbar" });
  const add = el("button", { class: "btn primary", text: "Set up cloud agent" });
  action.append(el("div", { class: "spacer" }), add);
  add.disabled = !state.cloudChatsLoaded;

  add.addEventListener("click", () => openCloudPicker(add, state, redraw));

  // An empty array is also what main exposes before a chat-list attempt lands,
  // and after a failed one. Neither says the account has no chats. Keep any
  // known agents and the failure that explains why setup is unavailable.
  if (!state.cloudChatsLoaded) {
    const body = [action];
    if (state.cloudChatsError) {
      body.push(cloudErrorBanner(state.cloudChatsError, "Chats could not be loaded"));
    }
    else body.push(el("div", { class: "cloud-progress cloud-loading" }, [
          el("span", { class: "cloud-spinner", attrs: { "aria-hidden": "true" } }),
          el("span", { text: "Loading chats…" }),
        ]));
    const refreshError = cloudErrorBanner(state.cloudAgentsError);
    if (refreshError) body.push(refreshError);
    if (state.cloudActionError) {
      body.push(el("div", { class: "cloud-callout cloud-error" }, [
        el("div", { class: "cloud-callout-title", text: "That change did not finish" }),
        el("p", { class: "faint", text: cloudErrorCopy(state.cloudActionError) }),
      ]));
    }
    const roster = cloudAgentList(state, redraw);
    if (roster) body.push(roster);
    return body;
  }

  const body = [action];
  const refreshError = cloudErrorBanner(state.cloudAgentsError);
  if (refreshError) body.push(refreshError);
  if (state.cloudActionError) {
    body.push(el("div", { class: "cloud-callout cloud-error" }, [
      el("div", { class: "cloud-callout-title", text: "That change did not finish" }),
      el("p", { class: "faint", text: cloudErrorCopy(state.cloudActionError) }),
    ]));
  }
  const roster = cloudAgentList(state, redraw);
  if (roster) {
    body.push(roster);
  } else if (!state.cloudAgentsError) {
    body.push(el("div", { class: "empty cloud-empty", text: "No agents." }));
  }
  return body;
}
/**
 * The mounted Agents pane, while that tab is up. Holds the one refresh
 * `connect:changed` calls, so a mint or a dismissal redraws the flow and
 * nothing else.
 */
let agentsMounted = null;

/**
 * The Agents tab — first in the bar, and a place rather than an action.
 *
 * It was a "Connect a client" tab once, and that was the problem: a setup verb
 * makes an odd permanent home. Agents is what has access to this Mac, and
 * giving something access is one thing you do here. The roster of what already
 * has access is meant to join it in this pane once the app can ask for it.
 */
async function renderAgents() {
  const connectBox = el("div");
  const cloudBox = el("div");
  const cloudGroup = group(
    "Cloud agents",
    "AI assistants that live in a chat and run in the cloud — never on this Mac.",
    [cloudBox],
  );
  const refreshConnect = async () => {
    const s = await window.domo.connectGet();
    connectBox.replaceChildren(...(s ? connectNodes(s, refreshConnect) : []));
    cloudBox.replaceChildren(...(s ? cloudNodes(s, refreshConnect) : []));
    if (s) syncStaticModal(s, refreshConnect);
    return s;
  };
  await refreshConnect();

  // ---- Approvals: what happens when one of those agents asks for something.
  //
  // It sits here, under the clients, because that is the order of the two
  // questions: what can reach this Mac, and what it may do when it does. The
  // stored mode values are untouched — every label below is display only.
  let inference = await window.domo.inferenceGet();
  const modeChips = el("div", { class: "chips" });
  const modeNote = el("p", { class: "faint chip-note", text: "" });
  const modeHintLine = el("p", { class: "faint mode-hint", text: "" });

  // The purpose statement, and the two things that have to be said beside it.
  // Device-owner text: it is read and written through the settings IPC pair and
  // nowhere else, and it reaches no rule key, grant, or sandbox profile.
  const purposeInput = el("textarea", {
    class: "text",
    attrs: { placeholder: PURPOSE_PLACEHOLDER },
  });
  purposeInput.value = await window.domo.agentPurposeGet();
  // On commit only — blur or Enter: an `input` handler would persist every
  // half-written sentence on the way to the real one. The stored value is
  // what goes back on screen, so the field shows what the reviewer will read.
  purposeInput.addEventListener("change", async () => {
    purposeInput.value = await window.domo.agentPurposeSet(purposeInput.value);
  });
  const purposeBlock = el("div", { class: "revealed" }, [
    el("div", { class: "field" }, [el("label", { text: PURPOSE_LABEL }), purposeInput]),
    ...PURPOSE_CAVEATS.map((text) => el("p", { class: "faint", text })),
  ]);

  // Whether the reviewer may speak up in Ask mode. It sits in this card because
  // the mode it depends on is set here: the suggestion is only ever shown when
  // a human is being asked, and only a reviewer with a credential can produce
  // one, so both of its conditions are one row above it.
  const suggestCheck = el("input", { attrs: { type: "checkbox" } });
  suggestCheck.checked = await window.domo.showSuggestionsGet();
  const suggestLabel = el("label", { class: "check block" }, [
    suggestCheck,
    el("span", { text: "Let the reviewer suggest an answer when an approval window opens" }),
  ]);
  suggestCheck.addEventListener("change", () => window.domo.showSuggestionsSet(suggestCheck.checked));

  // What a reviewer with no credential costs, said rather than enforced — the
  // mode is still the owner's to choose, and choosing it is not an error to
  // prevent.

  const renderApprovals = () => {
    const mode = inference.approvalMode;
    const hasKey = inference.available;
    // How to get a reviewer. One reviewer, one answer — and the two sentences
    // below both end in it, so they cannot come to disagree about the remedy.
    const remedy = ": sign in to Plow in Settings.";
    // Only worth saying when the owner has actually asked the reviewer to
    // decide. The second half is the part people get wrong: a denial here is
    // not a freeze, because a rule already approved is a decision they made.
    modeNote.textContent =
      mode === "adversarial" && !hasKey
        ? `The AI Reviewer has no credential${remedy} ` +
          "Until then it denies anything it is asked to decide — requests already " +
          "covered by an always-allow rule keep running, unless the agent has its own " +
          "AI Reviewer switched on."
        : "";
    // The suggestion is only ever shown in Ask mode, and only by a reviewer
    // that can run. Dead rather than hidden: a checkbox that vanished would
    // read as a setting the app lost.
    const suggestOn = mode === "ask" && hasKey;
    suggestCheck.disabled = !suggestOn;
    suggestLabel.classList.toggle("disabled", !suggestOn);
    const chip = (value, label) => {
      const chip = el("span", {
        class: "chip" + (mode === value ? " active" : ""),
      }, [el("span", { text: label })]);
      chip.addEventListener("click", async () => {
        // What MAIN stored, not what was asked for. Main takes any known mode
        // now, but it is still the one that decides what is on disk, and the
        // pane must show that rather than what it optimistically asked for.
        await window.domo.approvalModeSet(value);
        inference = await window.domo.inferenceGet();
        renderApprovals();
      });
      return chip;
    };
    modeChips.replaceChildren(
      chip("ask", "Ask me every time"),
      chip("adversarial", "AI Reviewer decides"),
      chip("approve", "Approve everything"),
      chip("deny", "Deny everything"),
    );
    purposeBlock.hidden = mode !== "adversarial";
    // Ask mode's hint points at the checkbox below it. With no credential that
    // checkbox is dead, so pointing at it is an instruction that cannot be
    // followed — say what is actually true instead.
    if (mode === "ask" && !hasKey) {
      modeHintLine.textContent =
        "Any request a rule doesn't already cover opens an approval window. " +
        `The AI Reviewer has no credential, so it cannot suggest an answer${remedy}`;
    } else if (mode === "approve") {
      // "Every request" was true until a cloud agent could carry its own
      // reviewer. Saying it still would describe the one case the switch exists
      // to create as though the switch did nothing.
      modeHintLine.textContent =
        "Every request is allowed without asking you and without review — except from an " +
        "agent with its own AI Reviewer switched on, which is reviewed every time.";
    } else if (mode === "deny") {
      modeHintLine.textContent =
        "Any request a rule doesn't already cover is refused without asking you.";
    } else {
      // Unknown stored values keep the card useful by falling back to Ask.
      modeHintLine.textContent = mode === "adversarial" ? "" :
        "Any request a rule doesn't already cover opens an approval window. " +
        "The AI Reviewer can still suggest an answer — turn that on below.";
    }
    modeHintLine.hidden = mode === "adversarial";
  };
  renderApprovals();

  // Signing in or out changes what the reviewer can do, not what the owner
  // chose — the stored mode stays put — so this only re-reads and redraws.
  const refreshApprovals = async () => {
    inference = await window.domo.inferenceGet();
    renderApprovals();
  };
  agentsMounted = { refreshConnect, refreshApprovals };

  // `settings` alongside `agents` on purpose: the group card, its title and its
  // description are the same furniture Settings uses, and this pane is one of
  // those groups that outgrew the pane it was in.
  view.replaceChildren(el("div", { class: "panel agents settings" }, [
    cloudGroup,
    group(
      // The designer's title and subtitle.
      "Connect an MCP client",
      "Add this server URL to Claude Code, Codex, Cursor, or any MCP-compatible client.",
      [connectBox],
    ),
    group(
      "Approvals",
      "What happens when an agent asks to do something on this Mac. Requests already covered " +
        "by an always-allow rule skip this — unless the agent has its own AI Reviewer switched " +
        "on, which is reviewed every time — manage those in Rules. Anything the AI Reviewer " +
        "sees — the request, the paths asked for, the agent's identity, its goal and plan, the " +
        "capabilities it asked for, its recent activity on this Mac, and what you say agents " +
        "are for — is sent to Plow to be judged, and billed to your account; nothing from " +
        "other agents goes with it.",
      [modeChips, modeNote, purposeBlock, modeHintLine, suggestLabel],
    ),
  ]));
}

/** One honest line about the relay link, from what the main process reports. */
function relayStatusText(relay) {
  if (!relay.hasCredential) return "Not signed in.";
  return relay.connected ? "Connected." : "Not connected — retrying.";
}

function capText(c) {
  switch (c.kind) {
    case "fs.read": return "read: " + (c.paths || []).join(", ");
    case "fs.write": return "write: " + (c.paths || []).join(", ");
    case "process.exec": return "run " + (c.argv || []).join(" ");
    case "network": return c.allowed ? "network: allowed" : "network: denied";
    case "tool": return "tool: " + (c.tool || "?");
    case "browser": return "browse: " + (c.origins || []).join(", ");
    case "credential":
      // A rule saved before the metadata capability was removed can still be
      // sitting in rules.json. Nothing requests that shape any more, so it
      // grants nothing — but the owner should read back what they actually
      // approved, not see it relabelled as a fill grant they never gave.
      return c.access === "metadata"
        ? "credentials: list names/labels (no longer requested)"
        : "credentials: fill " + (c.items || []).join(", ");
    default: return c.kind;
  }
}

// ---- Software updates (banner + settings section) ----

const updateBanner = document.getElementById("updateBanner");

/** One honest status line from the updater's whole-state shape. */
function updateStatusText(u) {
  if (!u.supported) return "This build updates with git, not the feed — only the packaged app self-updates.";
  if (u.phase === "checking") return "Checking for updates…";
  if (u.phase === "downloading") return `Downloading Plow Latch ${u.availableVersion}…`;
  if (u.phase === "ready")
    return `Plow Latch ${u.availableVersion} is downloaded — restart to install${u.autoInstall ? ", or it installs when you quit" : ""}.`;
  if (u.phase === "error") return `Last check failed: ${u.error}`;
  // "You're up to date" only when a check THIS session confirmed it; a
  // timestamp persisted from an earlier launch only proves we once looked.
  if (u.upToDate) return `You're up to date. Last checked ${new Date(u.lastCheckAt).toLocaleString()}.`;
  return u.lastCheckAt ? `Last checked ${new Date(u.lastCheckAt).toLocaleString()}.` : "Not checked yet.";
}

/** The passive banner: visible only while an update is staged and undismissed. */
async function refreshUpdateBanner() {
  const u = await window.domo.updatesGet();
  const show = u.supported && u.phase === "ready" && !u.dismissed;
  updateBanner.hidden = !show;
  if (!show) return;
  const restart = el("button", { class: "btn primary", text: "Restart to Update" });
  restart.addEventListener("click", () => window.domo.updatesRestart());
  const later = el("button", { class: "btn", text: "Later" });
  later.addEventListener("click", () => window.domo.updatesDismiss());
  const close = el("button", { class: "banner-close", text: "×", attrs: { "aria-label": "Dismiss" } });
  close.addEventListener("click", () => window.domo.updatesDismiss());
  updateBanner.replaceChildren(
    close,
    el("span", { text: `Plow Latch ${u.availableVersion} is ready to install.` }),
    el("div", { class: "spacer" }),
    later,
    restart,
  );
}

// ---- Settings ----

async function renderSettings() {
  // The Plow account. There is no credential field and no URL field here: the
  // credential is minted by first-run login and never leaves the main process,
  // and the API origin is baked into the build (a token is only valid against
  // the environment that minted it, so an editable origin could only be wrong).
  const relay = await window.domo.relayGet();
  // The machine's own name, for the one row this group keeps. Already on the
  // bridge for the titlebar; no new IPC and no API call for it.
  const status = await window.domo.statusGet();
  const relayNote = el("p", { class: "faint", text: relayStatusText(relay) });
  // The "Connect a Client" button that used to sit here is gone: connecting a
  // client is now a subsection of this same group, so a button navigating to it
  // would only point at itself. Signing in is still a real action — unreachable
  // in practice (the gate means this window would not exist signed out), but it
  // goes somewhere real rather than nowhere.
  const signIn = el("button", { class: "btn primary", text: "Sign In" });
  signIn.addEventListener("click", () => window.domo.onboardingOpen());
  // The account itself lives on the web; this is the shortcut to it, shown
  // only when there is an account to view.
  const viewAccount = externalBtn("View Account", "account");
  const signOut = el("button", { class: "btn danger", text: "Sign Out" });
  // No explicit refresh: signing out restarts the relay, which publishes
  // `status:changed`, which is already the one thing that redraws this pane.
  signOut.addEventListener("click", () => window.domo.relaySignOut());
  // A stable container the account rows are drawn into, so signing in or out
  // rewrites its contents rather than the pane.
  const accountBox = el("div", { class: "account" });
  const refreshAccount = async () => {
    const relay = await window.domo.relayGet();
    relayNote.textContent = relayStatusText(relay);
    // `hidden` is not enough: `.btn` is `display: inline-flex`, which outranks
    // the user-agent `[hidden] { display: none }` rule and leaves a Sign In
    // button sitting next to Sign Out on an account that is already signed in.
    signIn.style.display = relay.hasCredential ? "none" : "";
    viewAccount.style.display = relay.hasCredential ? "" : "none";
    signOut.disabled = !relay.hasCredential;
    // One row, and it is about this Mac rather than about the wire. The agent
    // endpoint lived here too, which is the same string the Agents tab shows as
    // step 1 of connecting a client — where it can actually be copied and used;
    // printing it twice is most of what made this group read as diagnostics.
    // The account UID went with it: nothing a person can act on, and support
    // reads it out of the audit log.
    accountBox.replaceChildren(
      ...(relay.hasCredential
        ? [
            el("div", { class: "field" }, [
              el("label", { text: "This Mac" }),
              el("div", { class: "mono faint", text: `Plow Latch (${status.name || "Mac"})` }),
            ]),
          ]
        : []),
    );
  };
  await refreshAccount();

  // Software updates: version + status + a check/restart action + the two
  // automation preferences. Everything renders from one updates:get shape.
  // These nodes are stable for the pane's lifetime: controller transitions
  // patch them in place (refreshUpdates below) rather than re-rendering the
  // pane, which would reset its scroll position on every phase change.
  let u = await window.domo.updatesGet();
  const updateStatus = el("p", { class: "faint" });
  const updateAction = el("button", { class: "btn" });
  updateAction.addEventListener("click", async () => {
    if (u.phase === "ready") await window.domo.updatesRestart();
    else await window.domo.updatesCheck();
    // The controller's change events redraw these nodes as the check runs.
  });
  const autoCheckBox = el("input", { attrs: { type: "checkbox" } });
  autoCheckBox.addEventListener("change", () => window.domo.updatesSetAutoCheck(autoCheckBox.checked));
  const autoCheckLabel = el("label", { class: "check block" }, [
    autoCheckBox,
    el("span", { text: "Automatically check for updates" }),
  ]);
  const autoInstallBox = el("input", { attrs: { type: "checkbox" } });
  autoInstallBox.addEventListener("change", () => window.domo.updatesSetAutoInstall(autoInstallBox.checked));
  const autoInstallLabel = el("label", { class: "check block" }, [
    autoInstallBox,
    el("span", { text: "Install downloaded updates when quitting Plow Latch" }),
  ]);
  const applyUpdates = () => {
    const ready = u.phase === "ready";
    updateStatus.textContent = updateStatusText(u);
    updateAction.textContent = ready ? "Restart to Update" : "Check for Updates";
    updateAction.className = ready ? "btn primary" : "btn";
    updateAction.disabled = !u.supported || u.phase === "checking" || u.phase === "downloading";
    autoCheckBox.checked = u.autoCheck;
    autoCheckBox.disabled = !u.supported;
    autoInstallBox.checked = u.autoInstall;
    autoInstallBox.disabled = !u.supported;
    autoCheckLabel.classList.toggle("disabled", !u.supported);
    autoInstallLabel.classList.toggle("disabled", !u.supported);
  };
  applyUpdates();

  // Launch at Login. macOS owns the actual bit — System Settings → General →
  // Login Items can flip it while this pane is open — so the focus refresh
  // re-reads it the same way it re-probes capabilities, and a toggle renders
  // what the OS answered, not what was clicked.
  let launch = await window.domo.launchGet();
  const launchBox = el("input", { attrs: { type: "checkbox" } });
  const launchLabel = el("label", { class: "check" }, [
    launchBox,
    el("span", { text: "Open Plow Latch when you log in" }),
  ]);
  // Why the toggle is dead, when it is: a disabled control that says nothing
  // is a dead end.
  const launchNote = el("p", { class: "faint cap-note", text:
    "Only the installed app can add itself as a login item, so this from-source run can't." });
  const applyLaunch = () => {
    launchBox.checked = launch.openAtLogin;
    launchBox.disabled = !launch.supported;
    launchLabel.classList.toggle("disabled", !launch.supported);
    launchNote.hidden = launch.supported;
  };
  launchBox.addEventListener("change", async () => {
    launch = await window.domo.launchSet(launchBox.checked);
    applyLaunch();
  });
  applyLaunch();

  // Capabilities: what macOS lets the app itself reach. Full Disk Access has
  // no prompt an app can raise — the only grant path is the switch in System
  // Settings — so the button deep-links there (a key into main's table, like
  // every external open) and the status re-probes when focus comes back to
  // this window (the boot()-installed focus listener), which is the first
  // moment the pane can learn what happened over there.
  const capDot = el("span", { class: "status-dot" });
  const capStatus = el("span", { class: "faint", text: "…" });
  const applyCapabilities = (caps) => {
    capDot.className = "status-dot" + (caps.fullDiskAccess ? " on" : "");
    capStatus.textContent = caps.fullDiskAccess ? "Granted" : "Not granted";
  };
  applyCapabilities(await window.domo.capabilitiesGet());
  // Ellipsis, not ↗ (see extArrow): the click only starts this — the user
  // still has to flip the toggle over there.
  const openFullDisk = el("button", { class: "btn", text: "Open System Settings…" });
  openFullDisk.addEventListener("click", () => window.domo.openExternal("fullDiskSettings"));

  // One Support destination: icon, title + blurb, and a button that asks main
  // to open the URL behind `key` — the renderer never holds the URL itself.
  const supportRow = (iconNode, title, desc, buttonLabel, key) => {
    const open = externalBtn(buttonLabel, key);
    return el("div", { class: "support-row" }, [
      iconNode,
      el("div", { class: "support-copy" }, [
        el("div", { class: "support-title", text: title }),
        el("p", { class: "faint", text: desc }),
      ]),
      el("div", { class: "spacer" }),
      open,
    ]);
  };

  // What a status change re-reads: display nodes only, every one of them read
  // back from main rather than remembered here.
  settingsMounted = {
    refresh: async () => {
      await refreshAccount();
      applyCapabilities(await window.domo.capabilitiesGet());
      launch = await window.domo.launchGet();
      applyLaunch();
    },
    refreshUpdates: async () => {
      u = await window.domo.updatesGet();
      applyUpdates();
    },
  };
  // Re-read updater state now that refreshUpdates is installed: a transition
  // arriving during the awaits above found settingsMounted unset and was
  // dropped — and a missed final transition (say, update-downloaded) would
  // otherwise leave this pane stale with no later event to correct it.
  await settingsMounted.refreshUpdates();

  view.replaceChildren(el("div", { class: "panel settings" }, [
    // The old subtitle promised a phone number this screen never shows — the
    // activation flow learns it server-side from the inbound SMS, and the OTP
    // fallback holds it in memory and drops it on reset. Say what is true of
    // what is on screen.
    group("Plow Account", "The account agents reach this Mac through.", [
      accountBox,
      el("div", { class: "row" }, [relayNote, el("div", { class: "spacer" }), viewAccount, signOut, signIn]),
    ]),
    group("Capabilities", "Extended capabilities that let Plow Latch reach parts of this Mac that macOS blocks by default.", [
      el("div", { class: "support-row" }, [
        el("div", { class: "support-copy" }, [
          el("div", { class: "cap-title" }, [
            el("span", { class: "support-title", text: "Full Disk Access" }),
            capDot,
            capStatus,
          ]),
          el("p", { class: "faint", text:
            "macOS blocks Messages, Mail, Safari data, and Time Machine backups until you grant this. " +
            "Agents need it to do things like read a sign-in code texted to you in Messages, or search your Mail archive for a receipt. " +
            "To grant it, turn on Plow Latch under Privacy & Security → Full Disk Access. macOS may ask to quit and reopen the app." }),
        ]),
        el("div", { class: "spacer" }),
        openFullDisk,
      ]),
      el("div", { class: "support-row" }, [
        el("div", { class: "support-copy" }, [
          el("div", { class: "support-title", text: "Launch at Login" }),
          el("p", { class: "faint", text:
            "Agents can reach this Mac only while Plow Latch is running." }),
          launchLabel,
          launchNote,
        ]),
      ]),
    ]),
    group("Software Updates", `Version ${u.currentVersion}`, [
      el("div", { class: "row" }, [updateStatus, el("div", { class: "spacer" }), updateAction]),
      autoCheckLabel,
      autoInstallLabel,
    ]),
    group("Support", null, [
      supportRow(
        discordIcon(),
        "Join our Discord",
        "Get help, share feedback, and hear about updates — our community and team are here.",
        "Join Discord",
        "discord",
      ),
      supportRow(
        globeIcon(),
        "See Us Build",
        "Watch the livestream to watch us build the Plow Latch app in public.",
        "Watch Livestream",
        "website",
      ),
    ]),
  ]));
}

function render() {
  if (currentTab === "agents") renderAgents();
  else if (currentTab === "audit") renderAudit();
  else if (currentTab === "rules") renderRules();
  else if (currentTab === "vault") renderVault(view, () => currentTab === "vault");
  else if (currentTab === "settings") renderSettings();
}

// Returns whether the switch actually happened. Leaving the Vault replaces the
// whole pane, so an open form with unsaved edits gets a say first — and a caller
// must not persist a tab the owner backed out of.
async function selectTab(tab) {
  // Already there: a rebuild would throw away an open form for no navigation at
  // all, which is the loss this guard exists to prevent.
  if (tab === currentTab) return true;
  if (currentTab === "vault" && !(await vaultConfirmLeave())) return false;
  currentTab = tab;
  // Leaving Agents closes the fallback: it is a disclosure, and coming back to
  // a form you did not open is a surprise.
  if (tab !== "agents") { staticOpen = false; closeStaticModal(); closeCloudModal(); }
  if (tab !== "audit") auditMounted = null; // avoid stale refreshes into detached nodes
  if (tab !== "settings") settingsMounted = null;
  if (tab !== "agents") agentsMounted = null;
  for (const b of seg.querySelectorAll("button")) b.classList.toggle("active", b.dataset.tab === tab);
  render();
  return true;
}

// Let the headless preload probe drive the tabs without synthesising clicks.
window.__domoSelectTab = selectTab;

seg.addEventListener("mousedown", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (await selectTab(btn.dataset.tab)) window.domo.uiSetTab(btn.dataset.tab); // persist across launches
});

window.domo.onAuditChanged(() => { if (currentTab === "audit") refreshAudit({ followTop: true }); });
window.domo.onStatusChanged(() => {
  refreshStatus();
  // Signing in or out changes what the account group says, so an open Settings
  // pane has to re-read — main fires this saying "Settings re-reads what
  // changed", and until now only the header did.
  if (currentTab === "settings") settingsMounted?.refresh();
  // Signing in or out changes whether the flow has a URL to show at all — and,
  // since the Approvals card moved here, whether the reviewer can run.
  if (currentTab === "agents") {
    agentsMounted?.refreshConnect();
    agentsMounted?.refreshApprovals();
  }
});
// Minting or dismissing a credential redraws only the Agents flow.
window.domo.onConnectChanged(() => { agentsMounted?.refreshConnect(); });
window.domo.onUpdatesChanged(() => {
  refreshUpdateBanner();
  // In place, never renderSettings(): a full rebuild resets the pane's scroll
  // on every background phase change.
  if (currentTab === "settings") settingsMounted?.refreshUpdates();
});
// The menu-bar "Check for Updates…" lands here so its outcome is visible.
// Closing the window or quitting throws an open Vault form away too, so main
// asks here first. Anything outside the Vault has nothing to lose.
window.domo.onConfirmLeave(async () => {
  window.domo.confirmLeaveReply(currentTab === "vault" ? await vaultConfirmLeave() : true);
});

// Only check once Settings is actually on screen — see checkForUpdatesFromMenu.
window.domo.onShowSettings(async () => {
  if (await selectTab("settings")) window.domo.updatesCheck();
});
// Granting Full Disk Access happens in System Settings, and no event reaches
// this app when it does — the moment the pane can learn the outcome is when
// the person comes back.
window.addEventListener("focus", () => {
  if (currentTab === "settings") settingsMounted?.refresh();
});

// Restore the last-selected tab (falls back to the HTML default on any miss).
async function boot() {
  refreshStatus();
  refreshUpdateBanner();
  const saved = await window.domo.uiGetTab();
  const known = ["agents", "audit", "rules", "vault", "settings"];
  selectTab(known.includes(saved) ? saved : "audit");
}
boot();
