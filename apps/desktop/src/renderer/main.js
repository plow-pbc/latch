/* Main-window renderer. Sandboxed: no Node, no ipcRenderer — only the narrow
   `window.domo` bridge from preload. All agent-derived text is inserted with
   textContent (never innerHTML), so nothing on the wire can inject markup. */

const view = document.getElementById("view");
const seg = document.getElementById("seg");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

let currentTab = "audit";
let filter = "all";
// The mounted Settings pane, while that tab is up. Holds a `refresh` that
// updates the display nodes in place — the editable key field is never rebuilt,
// so no amount of re-reading can take a half-typed key with it.
let settingsMounted = null;

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

const ICONS = {
  command: "m4 17 6-6-6-6 M12 19h8",
  file: "M14 3v5h5 M7 3h8l5 5v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
  access: "M12 3 4 6v6c0 5 3.5 7.5 8 9 4.5-1.5 8-4 8-9V6z",
  agent: "M4 8h16v12H4z M12 8V4",
  info: "M12 2v10 M18.4 6.6a9 9 0 1 1-12.8 0",
  browser: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3a14 14 0 0 1 0 18 M12 3a14 14 0 0 0 0 18",
};
function icon(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ico");
  const d = (ICONS[kind] || ICONS.info).split(" M");
  for (let i = 0; i < d.length; i++) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", (i === 0 ? "" : "M") + d[i]);
    svg.appendChild(p);
  }
  return svg;
}

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
  const titleSpan = el("span");
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
 * mark is worse than none, so this is the name and the mock's ↗ until real
 * assets arrive.
 */
function clientCard(key, name) {
  const card = el("button", { class: "client-card" }, [
    el("span", { class: "client-name", text: name }),
    el("span", { class: "client-arrow", text: "↗" }),
  ]);
  card.addEventListener("click", () => window.domo.openExternal(key));
  return card;
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

/**
 * The static-credential modal, while it is up.
 *
 * Lives on `document.body`, not inside `#view`: the pane behind it is made
 * `inert` while it is open, and a dialog nested inside the thing it disables
 * would disable itself.
 *
 * `nameInput` is held here and reused across refreshes for the reason the
 * API-key field is: a relay reconnect can redraw this while someone is halfway
 * through typing a name, and rebuilding the field would take the name with it.
 */
let staticModal = null;

/** Everything the modal switched off, switched back on. */
function closeStaticModal() {
  if (!staticModal) return;
  const { backdrop, trigger, onKeydown } = staticModal;
  document.removeEventListener("keydown", onKeydown, true);
  backdrop.remove();
  for (const node of document.querySelectorAll(".titlebar, #view, .update-banner")) {
    node.removeAttribute("inert");
  }
  staticModal = null;
  // Focus goes back where it came from, not to the top of the document.
  if (trigger && trigger.isConnected) trigger.focus();
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
  if (staticModal) return;
  const panel = el("div", { class: "modal", attrs: { role: "dialog", "aria-modal": "true" } });
  const backdrop = el("div", { class: "modal-backdrop" }, [panel]);
  const nameInput = el("input", { class: "text", attrs: { placeholder: "Claude Code" } });
  const onKeydown = (e) => {
    // Esc closes the form. It does NOT close a displayed credential.
    if (e.key !== "Escape" || staticModal?.holdingCredential) return;
    e.preventDefault();
    e.stopPropagation();
    staticOpen = false;
    closeStaticModal();
    redraw();
  };
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target !== backdrop || staticModal?.holdingCredential) return;
    staticOpen = false;
    closeStaticModal();
    redraw();
  });
  document.addEventListener("keydown", onKeydown, true);
  for (const node of document.querySelectorAll(".titlebar, #view, .update-banner")) {
    node.setAttribute("inert", "");
  }
  document.body.appendChild(backdrop);
  staticModal = { backdrop, panel, nameInput, trigger, onKeydown, kind: null, holdingCredential: false };
  nameInput.focus();
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
 * own. `redraw` repaints only this group — the pane around it holds a
 * half-typed API-key field that must never be replaced under the user.
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
    el("div", { class: "client-cards" }, [clientCard("claude", "Claude")]),
    ...fallback,
    note,
  ].filter(Boolean));

  // Scoped to this subsection: the account rows above it (Sign Out) are not
  // this subsection's to disable while it is mid-call.
  for (const b of box.querySelectorAll("button")) if (s.busy) b.disabled = true;
  return [box];
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
  const refreshConnect = async () => {
    const s = await window.domo.connectGet();
    connectBox.replaceChildren(...(s ? connectNodes(s, refreshConnect) : []));
    if (s) syncStaticModal(s, refreshConnect);
  };
  await refreshConnect();
  agentsMounted = { refreshConnect };

  // `settings` alongside `agents` on purpose: the group card, its title and its
  // description are the same furniture Settings uses, and this pane is one of
  // those groups that outgrew the pane it was in.
  view.replaceChildren(el("div", { class: "panel agents settings" }, [
    group(
      // The designer's title and subtitle.
      "Connect an MCP client",
      "Add this server URL to Claude Code, Codex, Cursor, or any MCP-compatible client.",
      [connectBox],
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
      return c.access === "metadata"
        ? "credentials: list names/labels"
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
  if (u.phase === "downloading") return `Downloading Plow ${u.availableVersion}…`;
  if (u.phase === "ready")
    return `Plow ${u.availableVersion} is downloaded — restart to install${u.autoInstall ? ", or it installs when you quit" : ""}.`;
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
    el("span", { text: `Plow ${u.availableVersion} is ready to install.` }),
    el("div", { class: "spacer" }),
    later,
    restart,
  );
}

// ---- Settings ----

/**
 * The vault's own account. Shown, not hidden: this is what the owner types into
 * the vault's page to read their own secrets, and either half can be replaced
 * with something they choose — the account key is re-wrapped underneath, so
 * what is already stored stays readable.
 */
/** One editable value with a Copy button beside it — never two of the same. */
function fieldRow(input) {
  const copy = el("button", { class: "btn small", text: "Copy" });
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(input.value);
    copy.textContent = "Copied";
    setTimeout(() => { copy.textContent = "Copy"; }, 1200);
  });
  return el("div", { class: "copyrow" }, [input, copy]);
}

async function renderVault() {
  const state = (await window.domo.vaultGet()) ?? { status: "empty" };
  if (state.status !== "ok") {
    // Locked and empty are different facts and get different words. A vault
    // whose key has moved — a Keychain reset, a Mac restored from backup — used
    // to render as "has not started yet", which sent people looking for a
    // server that was running fine.
    const locked = state.status === "locked";
    view.replaceChildren(el("div", { class: "panel" }, [
      el("div", { class: "section-label", text: "Your vault" }),
      el("div", { class: "empty", text: locked
        ? "This Mac can't unlock its vault account."
        : "The vault has not started yet." }),
      // Two rules here, both learned the hard way. No invented recovery:
      // `changeCredentials` refuses outright when the account cannot be read
      // ("this machine has no vault account yet"), and signing in on the vault's
      // own page needs the very password this state cannot produce. And no
      // asserting a cause the code cannot tell apart: `undecryptable` is one
      // `catch` covering a wrong key AND a damaged file, so the copy leads with
      // what is certain (the file is there and will not open), names the likely
      // cause as likely, and gives the remedy — which is the same either way.
      locked
        ? el("p", { class: "faint vault-note", text: state.reason === "no-storage"
            ? "The encrypted account is on disk, but this build has no secure storage to open it with. Nothing is lost; a build with secure storage will read it."
            : "The account file is present but cannot be opened. Usually that means the key is no longer in this Mac's Keychain — after a Keychain reset, a restore from backup, or a change to how the app identifies itself — and it can also mean the file itself is damaged. Either way the password cannot be recovered, here or anywhere: the vault would have to be set up again. Nothing has been deleted." }
          )
        : null,
    ].filter(Boolean)));
    return;
  }
  const creds = state.credentials;

  // Anchors go nowhere inside Electron; the main process opens the browser.
  const link = el("a", { class: "mono", text: creds.url, attrs: { href: creds.url } });
  link.addEventListener("click", (e) => {
    e.preventDefault();
    window.domo.vaultOpen();
  });

  const emailInput = el("input", { class: "text", attrs: { type: "text", spellcheck: "false" } });
  emailInput.value = creds.email;
  const passwordInput = el("input", { class: "text mono", attrs: { type: "text", spellcheck: "false" } });
  passwordInput.value = creds.password;

  const note = el("p", { class: "faint", text: "Sign in on that page with these two." });
  const save = el("button", { class: "btn primary", text: "Save changes" });
  save.addEventListener("click", async () => {
    save.disabled = true;
    note.textContent = "Changing…";
    try {
      const updated = await window.domo.vaultSet(emailInput.value.trim(), passwordInput.value);
      emailInput.value = updated.email;
      passwordInput.value = updated.password;
      note.textContent = "Saved. Sign in with these from now on.";
    } catch (err) {
      note.textContent = "Could not change it: " + (err && err.message ? err.message : String(err));
    }
    save.disabled = false;
  });

  view.replaceChildren(el("div", { class: "panel" }, [
    el("div", { class: "section-label", text: "Your vault" }),
    el("div", { class: "field" }, [el("label", { text: "Address" }), link]),
    el("div", { class: "field" }, [el("label", { text: "Email" }), fieldRow(emailInput)]),
    el("div", { class: "field" }, [el("label", { text: "Password" }), fieldRow(passwordInput)]),
    note,
    el("div", { class: "row" }, [save]),
  ]));
}

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
              el("div", { class: "mono faint", text: `Plow (${status.name || "Mac"})` }),
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
    el("span", { text: "Install downloaded updates when quitting Plow" }),
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
  const openFullDisk = el("button", { class: "btn", text: "Open System Settings" });
  openFullDisk.addEventListener("click", () => window.domo.openExternal("fullDiskSettings"));

  // One Support destination: icon, title + blurb, and a button that asks main
  // to open the URL behind `key` — the renderer never holds the URL itself.
  const supportRow = (iconNode, title, desc, buttonLabel, key) => {
    const open = el("button", { class: "btn", text: buttonLabel });
    open.addEventListener("click", () => window.domo.openExternal(key));
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

  // Anthropic API key — one of the two ways to power the adversarial agent.
  const apiKeyInput = el("input", { class: "text", attrs: { type: "password", placeholder: "sk-ant-…" } });
  apiKeyInput.value = await window.domo.apiKeyGet();

  // Which backend runs the reviewer. `inference` carries a per-provider
  // availability map and the active model — never a credential.
  let inference = await window.domo.inferenceGet();
  const reviewerNote = el("p", { class: "faint reviewer-note", text: "" });
  const providerChips = el("div", { class: "chips" });
  // Everything this pane knows about a provider, in one place: what to call it,
  // what it is waiting for when it cannot be picked, and where that lives.
  // Which providers exist, and whether each is usable, still comes from main —
  // this is display knowledge only.
  //
  // `hint` follows the chip's own label, so it must not repeat it: "Anthropic
  // API key: add one below to select it" reads; "Anthropic API key needs an
  // Anthropic API key" is what happens when it does.
  //
  // Declared after the reveal helpers it references (see below).
  let PROVIDERS;

  // Approval mode for operations — read from the SAME snapshot as availability,
  // because main decides both in one write.
  let currentMode = inference.approvalMode;
  const showSuggestions = await window.domo.showSuggestionsGet();
  // Adversarial mode needs a credential for the ACTIVE provider — a pasted
  // Anthropic key does not enable it while Plow is selected, and vice versa.
  let hasKey = inference.available[inference.provider];
  const modeChips = el("div", { class: "chips" });
  const MODES = [
    ["approve", "Approve"],
    ["adversarial", "Adversarial Agent"],
    ["ask", "Ask"],
    ["deny", "Deny"],
  ];

  const suggestCheck = el("input", { attrs: { type: "checkbox" } });
  suggestCheck.checked = showSuggestions;
  // Said once, under the mode chips, for the same reason the reviewer note
  // exists: a faded chip that explains nothing is a dead end.
  const modeNote = el("p", { class: "faint chip-note", text: "" });
  const suggestLabel = el("label", { class: "check" }, [
    suggestCheck,
    el("span", { text: "Show Adversarial Agent suggestions in Ask mode" }),
  ]);
  suggestCheck.addEventListener("change", () => window.domo.showSuggestionsSet(suggestCheck.checked));

  // Adversarial Agent needs an API key; the suggestions checkbox needs Ask mode
  // AND a key. Re-render whenever the mode or key presence changes.
  const renderModeChips = () => {
    // Whatever the ACTIVE provider is missing is what blocks Adversarial —
    // a pasted Anthropic key does not enable it while Plow is selected.
    const provider = PROVIDERS[inference.provider];
    modeNote.textContent = hasKey ? "" : provider.adversarial;
    modeChips.replaceChildren(...MODES.map(([value, label]) => {
      const disabled = value === "adversarial" && !hasKey;
      const chip = el("span", {
        class:
          "chip" +
          (currentMode === value ? " active" : "") +
          (disabled ? " disabled actionable" : ""),
        attrs: disabled ? { title: provider.adversarial } : {},
      }, [el("span", { text: label })]);
      if (disabled) {
        chip.addEventListener("click", provider.go);
      } else {
        chip.addEventListener("click", async () => {
          // What MAIN stored, not what was asked for. Adversarial is refused
          // when the active provider has no credential, and the credential can
          // go between this render and this click — so assuming the request
          // succeeded leaves the pane claiming a mode disk never took.
          currentMode = await window.domo.approvalModeSet(value);
          renderModeChips();
          updateSuggestEnabled();
        });
      }
      return chip;
    }));
  };
  const updateSuggestEnabled = () => {
    const on = currentMode === "ask" && hasKey;
    suggestCheck.disabled = !on;
    suggestLabel.classList.toggle("disabled", !on);
  };

  /**
   * Put the thing that would enable a chip in front of the user.
   *
   * A disabled control that says nothing is a dead end; the app knows exactly
   * what is missing, so the chip becomes the way to go fix it.
   */
  const revealApiKeyField = () => {
    apiKeyInput.scrollIntoView({ block: "center" });
    apiKeyInput.focus();
  };
  const revealAccount = () => {
    accountBox.scrollIntoView({ block: "center" });
    (signIn.style.display === "none" ? signOut : signIn).focus();
  };
  PROVIDERS = {
    plow: {
      label: "Plow account",
      hint: "sign in to select it",
      adversarial: "Adversarial Agent needs you signed in to Plow.",
      go: revealAccount,
    },
    anthropic: {
      label: "Anthropic API key",
      hint: "add one below to select it",
      adversarial: "Adversarial Agent needs an Anthropic API key — add one below.",
      go: revealApiKeyField,
    },
  };

  // A provider with no credential is disabled and cannot be selected; the main
  // process enforces the same rule, this only keeps the UI honest.
  const renderProviderChips = () => {
    // No fallback copy: `available` comes from main's frozen provider list, so a
    // key here that PROVIDERS does not know is a bug to see, not to paper over.
    const unavailable = Object.entries(inference.available)
      .filter(([, usable]) => !usable)
      .map(([value]) => `${PROVIDERS[value].label}: ${PROVIDERS[value].hint}`);
    // The note carries both facts: which reviewer is running, and — when a chip
    // is faded — what would un-fade it. Until now the only signal was opacity.
    reviewerNote.textContent =
      `Reviewer: ${inference.info}` +
      (unavailable.length ? ` · ${unavailable.join("; ")}.` : "");
    providerChips.replaceChildren(...Object.entries(inference.available).map(([value, usable]) => {
      const provider = PROVIDERS[value];
      const disabled = !usable;
      const chip = el("span", {
        class:
          "chip" +
          (inference.provider === value ? " active" : "") +
          (disabled ? " disabled actionable" : ""),
        attrs: disabled ? { title: `${provider.label} — ${provider.hint}` } : {},
      }, [el("span", { text: provider.label })]);
      if (disabled) {
        // Still clickable, deliberately: it cannot select the provider, but it
        // can take you to the field that would make selecting it possible.
        chip.addEventListener("click", provider.go);
      } else if (inference.provider !== value) {
        chip.addEventListener("click", async () => {
          // What main stored, not what was asked for: an unavailable provider
          // is refused there, and the answer is the refusal.
          applyInference(await window.domo.inferenceSet(value));
        });
      }
      return chip;
    }));
  };

  // Re-read the reviewer's state from main and redraw.
  //
  // This only READS. Main owns the interlock — it retires Adversarial mode in
  // the same write that takes a credential away — so the renderer's job is to
  // show what main decided, never to decide it too. The renderer used to write
  // the fallback itself from a half-typed field, which persisted Ask while the
  // stored key was still there and never put it back.
  const applyInference = (next) => {
    inference = next;
    currentMode = next.approvalMode;
    hasKey = next.available[next.provider];
    renderProviderChips();
    renderModeChips();
    updateSuggestEnabled();
  };

  // Only on `change` — on commit (blur or Enter), never per keystroke. An
  // `input` handler sees every transient value on the way to the real one,
  // including the empty field between clearing and pasting.
  apiKeyInput.addEventListener("change", async () => {
    await window.domo.apiKeySet(apiKeyInput.value.trim());
    applyInference(await window.domo.inferenceGet());
  });

  renderProviderChips();
  renderModeChips();
  updateSuggestEnabled();

  // What a status change re-reads. Display nodes only: `apiKeyInput` is not
  // among them and is never replaced, so there is no window in which a keystroke
  // can be lost — no flag, no deferral, nothing to get the ordering wrong.
  settingsMounted = {
    refresh: async () => {
      await refreshAccount();
      applyInference(await window.domo.inferenceGet());
      applyCapabilities(await window.domo.capabilitiesGet());
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
      el("div", { class: "row" }, [relayNote, el("div", { class: "spacer" }), signOut, signIn]),
    ]),
    group("Reviewer inference", "The provider you pick judges each operation, so it receives the command being reviewed, the paths it asks for, and that agent's recent activity on this Mac. It bills that account; nothing from other agents is sent.", [
      providerChips,
      reviewerNote,
    ]),
    group("Anthropic API Key", "Only needed to run the reviewer on your own Anthropic account. Stored locally.", [
      apiKeyInput,
    ]),
    group("Approval Mode", "How operations are decided.", [
      modeChips,
      modeNote,
      suggestLabel,
    ]),
    group("Capabilities", "Extended capabilities that let Plow reach parts of this Mac that macOS blocks by default.", [
      el("div", { class: "support-row" }, [
        el("div", { class: "support-copy" }, [
          el("div", { class: "cap-title" }, [
            el("span", { class: "support-title", text: "Full Disk Access" }),
            capDot,
            capStatus,
          ]),
          el("p", { class: "faint", text:
            "macOS blocks Messages, Mail, Safari data, and Time Machine backups until you grant this. " +
            "Agents need it to do things like read a sign-in code texted to you in Messages, or search your Mail archive for a receipt." }),
          el("p", { class: "faint cap-grant", text:
            "To grant it, turn on Plow under Privacy & Security → Full Disk Access. macOS may ask to quit and reopen the app." }),
        ]),
        el("div", { class: "spacer" }),
        openFullDisk,
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
        "Watch the livestream to watch us build the Plow app in public.",
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
  else if (currentTab === "vault") renderVault();
  else if (currentTab === "settings") renderSettings();
}

function selectTab(tab) {
  currentTab = tab;
  // Leaving Agents closes the fallback: it is a disclosure, and coming back to
  // a form you did not open is a surprise.
  if (tab !== "agents") { staticOpen = false; closeStaticModal(); }
  if (tab !== "audit") auditMounted = null; // avoid stale refreshes into detached nodes
  if (tab !== "settings") settingsMounted = null;
  if (tab !== "agents") agentsMounted = null;
  for (const b of seg.querySelectorAll("button")) b.classList.toggle("active", b.dataset.tab === tab);
  render();
}

// Let the headless preload probe drive the tabs without synthesising clicks.
window.__domoSelectTab = selectTab;

seg.addEventListener("mousedown", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  selectTab(btn.dataset.tab);
  window.domo.uiSetTab(btn.dataset.tab); // persist across launches
});

window.domo.onAuditChanged(() => { if (currentTab === "audit") refreshAudit({ followTop: true }); });
window.domo.onStatusChanged(() => {
  refreshStatus();
  // Signing in or out changes which providers Settings may offer, so an open
  // Settings pane has to re-read — main fires this saying "Settings re-reads
  // what changed", and until now only the header did.
  //
  // `status:changed` also fires on an ordinary relay reconnect, which the
  // person typing a key did not ask for and must not be punished by — so this
  // updates the account and provider nodes and leaves the field alone.
  if (currentTab === "settings") settingsMounted?.refresh();
  // Signing in or out changes whether the flow has a URL to show at all.
  if (currentTab === "agents") agentsMounted?.refreshConnect();
});
// Minting or dismissing a credential redraws only the Agents flow.
window.domo.onConnectChanged(() => { agentsMounted?.refreshConnect(); });
window.domo.onUpdatesChanged(() => {
  refreshUpdateBanner();
  // In place, never renderSettings(): a full rebuild resets the pane's scroll
  // (and would eat a half-typed API key) on every background phase change.
  if (currentTab === "settings") settingsMounted?.refreshUpdates();
});
// The menu-bar "Check for Updates…" lands here so its outcome is visible.
window.domo.onShowSettings(() => selectTab("settings"));
// Granting Full Disk Access happens in System Settings, and no event reaches
// this app when it does — the moment the pane can learn the outcome is when
// the person comes back. `refresh` updates display nodes only, so a focus
// change can never cost a half-typed key.
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
