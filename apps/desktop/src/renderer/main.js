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

function badge(tone, text) {
  return el("span", { class: `badge b-${tone}` }, [el("span", { class: "dot" }), el("span", { text })]);
}

// Close any open "⋯" overflow menu when clicking elsewhere.
function closeAllMenus() {
  for (const m of document.querySelectorAll(".menu")) m.classList.add("hidden");
}
document.addEventListener("click", closeAllMenus);

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

// ---- Goals ----

async function renderGoals() {
  const goals = await window.domo.goalsList();
  const titleInput = el("input", { class: "text", attrs: { placeholder: "Goal title" } });
  const textInput = el("textarea", { class: "text", attrs: { placeholder: "What should the agent do?" } });
  const addBtn = el("button", { class: "btn", text: "Add Goal" });
  addBtn.addEventListener("click", async () => {
    // A title is optional — the library derives one from the text if omitted.
    // Only skip a completely empty entry.
    if (!titleInput.value.trim() && !textInput.value.trim()) return;
    await window.domo.goalsAdd(titleInput.value.trim(), textInput.value.trim());
    renderGoals();
  });
  // Same 8px spacing as a goal item's action column.
  const composeActions = el("div", { class: "goal-actions" }, [addBtn]);

  const items = goals.map((g) => {
    // "⋯" overflow menu with a Remove item.
    const removeItem = el("button", { class: "menu-item", text: "Remove" });
    removeItem.addEventListener("click", async () => { await window.domo.goalsRemove(g.id); renderGoals(); });
    const menu = el("div", { class: "menu hidden" }, [removeItem]);
    const menuBtn = el("button", { class: "iconbtn", text: "⋯", attrs: { title: "More" } });
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasHidden = menu.classList.contains("hidden");
      closeAllMenus();
      if (wasHidden) menu.classList.remove("hidden");
    });

    // Left column: title + description (kept clear of the action column).
    const main = el("div", { class: "goal-main" }, [
      el("h4", { text: g.title }),
      el("p", { text: g.text }),
    ]);
    // Right column, top-aligned: the "⋯" menu in the top corner.
    const actions = el("div", { class: "goal-actions" }, [
      el("div", { class: "menu-wrap" }, [menuBtn, menu]),
    ]);
    return el("div", { class: "item goal-item" }, [main, actions]);
  });

  const children = [
    el("div", { class: "item" }, [
      el("div", { class: "field" }, [el("label", { text: "New goal" }), titleInput]),
      el("div", { class: "field" }, [textInput]),
      el("div", { class: "row" }, [el("div", { class: "spacer" }), composeActions]),
    ]),
  ];
  children.push(...items);
  view.replaceChildren(el("div", { class: "panel" }, children));
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
 * see `CLIENT_CONNECTOR_URLS` in main.ts. It is a shortcut past the clicks, not
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
  card.addEventListener("click", () => window.domo.connectOpenClient(key));
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

/* ---- The Vault tab, built to Mary's design (vault.html) ----------------
   Her markup and her class names; the styling lives in vault.css, scoped to
   `.vaultui` so no other screen changes. Everything here is fed by the real
   vault: the list, the values, and the secrets that are fetched only when the
   owner asks to see one. */

/** Her icons, as path data — the renderer builds SVG rather than taking markup. */
const VAULT_ICONS = {
  KEY: [["circle", { cx: "8", cy: "15", r: "4" }], ["path", { d: "M10.8 12.2L20 3" }],
        ["path", { d: "M17 6l2.5 2.5" }], ["path", { d: "M15 8l2.5 2.5" }]],
  CARD: [["rect", { x: "2.5", y: "5", width: "19", height: "14", rx: "2.5" }],
         ["path", { d: "M2.5 9.5h19" }], ["path", { d: "M6 15h4" }]],
  USER: [["circle", { cx: "12", cy: "8", r: "4" }], ["path", { d: "M5 20c0-3.3 3.1-5 7-5s7 1.7 7 5" }]],
  NOTE: [["path", { d: "M6 3h9l4 4v14H6z" }], ["path", { d: "M14 3v5h5" }], ["path", { d: "M9 13h7M9 17h5" }]],
  CHEV: [["path", { d: "M8 10l4 4 4-4" }]],
  EYE: [["path", { d: "M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" }], ["circle", { cx: "12", cy: "12", r: "3" }]],
  EYEOFF: [["path", { d: "M17.9 17.9A10.4 10.4 0 0 1 12 19c-7 0-11-7-11-7a19.6 19.6 0 0 1 5.1-5.9M9.9 4.2A10.6 10.6 0 0 1 12 4c7 0 11 7 11 7a19.7 19.7 0 0 1-2.3 3.3M9.9 9.9a3 3 0 0 0 4.2 4.2" }],
           ["path", { d: "M1 1l22 22" }]],
  SHIELD: [["path", { d: "M12 3l7 4v6c0 4-3 6.5-7 8-4-1.5-7-4-7-8V7z" }]],
  GEN: [["path", { d: "M21 12a9 9 0 1 1-2.6-6.4" }], ["path", { d: "M21 3v5h-5" }]],
  PLUS: [["path", { d: "M12 5v14M5 12h14" }]],
  CLOSE: [["path", { d: "M18 6L6 18M6 6l12 12" }]],
};

function vsvg(name, strokeWidth = "1.8") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", strokeWidth);
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const [tag, attrs] of VAULT_ICONS[name] ?? []) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.appendChild(node);
  }
  return svg;
}

/* The four types, laid out as her forms lay them out. `secret` is a value the
   vault never hands over with the item — it is fetched one at a time, which is
   what the eye button does. */
const VAULT_TYPES = {
  login: {
    label: "Login", icon: "KEY", placeholder: "e.g. Notion",
    groups: [
      { head: "Login credentials", fields: [
        { key: "username", label: "Username", placeholder: "you@example.com" },
        { key: "password", label: "Password", secret: true, generate: true, placeholder: "••••••••••••",
          hint: "Use the generator to create a strong, unique password" },
        { key: "totp", label: "Authenticator key (TOTP)", secret: true, placeholder: "Optional — for 2FA codes" },
      ] },
      { head: "Website (URI)", required: true, urls: true },
      { head: "Notes", fields: [{ key: "notes", placeholder: "Optional", textarea: true }] },
    ],
  },
  card: {
    label: "Card", icon: "CARD", placeholder: "e.g. Visa •••• 4242",
    groups: [
      { head: "Card details", fields: [
        { key: "cardholderName", label: "Cardholder name", placeholder: "Name on card" },
        { key: "number", label: "Number", secret: true, placeholder: "•••• •••• •••• ••••" },
        { key: "brand", label: "Brand", placeholder: "Visa, Mastercard…" },
        { key: "expMonth", label: "Expiration month", placeholder: "MM", half: true },
        { key: "expYear", label: "Expiration year", placeholder: "YYYY", half: true },
        { key: "code", label: "Security code (CVV)", secret: true, placeholder: "•••" },
      ] },
      { head: "Notes", fields: [{ key: "notes", placeholder: "Optional", textarea: true }] },
    ],
  },
  identity: {
    label: "Identity", icon: "USER", placeholder: "e.g. Personal identity",
    groups: [
      { head: "Name", fields: [
        { key: "title", label: "Title", placeholder: "Mr, Ms, Dr…", half: true },
        { key: "firstName", label: "First name", half: true },
        { key: "middleName", label: "Middle name", placeholder: "Optional", half: true },
        { key: "lastName", label: "Last name", half: true },
        { key: "company", label: "Company", placeholder: "Optional" },
      ] },
      { head: "Contact", fields: [
        { key: "email", label: "Email", half: true },
        { key: "phone", label: "Phone", half: true },
        { key: "username", label: "Username", placeholder: "Optional" },
      ] },
      { head: "Address", fields: [
        { key: "address1", label: "Address 1" },
        { key: "address2", label: "Address 2", placeholder: "Optional" },
        { key: "address3", label: "Address 3", placeholder: "Optional" },
        { key: "city", label: "City / Town", half: true },
        { key: "state", label: "State / Province", half: true },
        { key: "postalCode", label: "ZIP / Postal code", half: true },
        { key: "country", label: "Country", half: true },
      ] },
      { head: "Numbers", fields: [
        { key: "ssn", label: "Social Security number", secret: true, placeholder: "•••-••-••••" },
        { key: "passportNumber", label: "Passport number", placeholder: "Optional" },
        { key: "licenseNumber", label: "License number", placeholder: "Optional" },
      ] },
      { head: "Notes", fields: [{ key: "notes", placeholder: "Optional", textarea: true }] },
    ],
  },
  note: {
    label: "Secure note", icon: "NOTE", placeholder: "e.g. Recovery codes",
    groups: [
      { head: "Note", fields: [{ key: "notes", textarea: true,
        placeholder: "Anything you want your agents to be able to reference on approval…" }] },
    ],
  },
};

function errText(err) {
  return err && err.message ? String(err.message).replace(/^Error: /, "") : String(err);
}

/** Her toast: one line, bottom of the pane, gone on its own. */
let toastTimer = null;
function vtoast(message) {
  const node = document.querySelector(".vaultui .toast");
  if (!node) return;
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2200);
}

/** A password worth generating: 20 characters from the machine's own RNG. */
function generatedPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+";
  const bytes = new Uint32Array(20);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

/**
 * One field, her way: label, a wrapping box, and the small buttons that belong
 * to it. A secret starts blank — the vault has not handed it over — and the eye
 * asks for it, which is the request the vault's audit records.
 */
function vfield(spec, ctx) {
  const input = spec.textarea
    ? el("textarea", { class: "inp", attrs: { placeholder: spec.placeholder ?? "" } })
    : el("input", {
        class: "inp",
        attrs: {
          type: spec.secret ? "password" : "text",
          spellcheck: "false",
          placeholder: spec.placeholder ?? "",
          ...(spec.key === "name" ? { "data-name": "1" } : {}),
        },
      });
  const stored = ctx.item ? (spec.key === "notes" ? ctx.item.notes : ctx.item.fields[spec.key]) : "";
  if (!spec.secret && stored) input.value = stored;
  ctx.inputs[spec.key] = input;

  const buttons = [];
  if (spec.secret) {
    const held = ctx.saved && (ctx.item.secrets || []).includes(spec.key);
    const eye = el("button", { class: "mini eye", attrs: { type: "button", title: "Reveal" } }, [vsvg("EYE")]);
    eye.addEventListener("click", async () => {
      if (input.getAttribute("type") === "text") {
        input.setAttribute("type", "password");
        eye.replaceChildren(vsvg("EYE"));
        return;
      }
      if (held && !input.value) {
        eye.disabled = true;
        try {
          input.value = await window.domo.vaultReveal(ctx.item.id, spec.key);
        } catch (err) {
          vtoast("Could not read it: " + errText(err));
          eye.disabled = false;
          return;
        }
        eye.disabled = false;
      }
      input.setAttribute("type", "text");
      eye.replaceChildren(vsvg("EYEOFF"));
    });
    buttons.push(eye);
  }
  if (spec.generate) {
    const gen = el("button", { class: "mini gen", attrs: { type: "button", title: "Generate password" } }, [vsvg("GEN")]);
    gen.addEventListener("click", () => {
      input.value = generatedPassword();
      input.setAttribute("type", "text");
      ctx.onChange?.();
    });
    buttons.push(gen);
  }
  input.addEventListener("input", () => ctx.onChange?.());

  const label = spec.label
    ? el("label", { text: spec.label + " " }, spec.required ? [el("span", { class: "req", text: "*" })] : [])
    : null;
  const hint = spec.hint ? el("span", { class: "gen-hint" }, [vsvg("GEN"), el("span", { text: " " + spec.hint })]) : null;
  return el("div", { class: "field" + (spec.secret ? " secret" : "") + (spec.half ? "" : " span2") },
    [label, el("div", { class: "inwrap" }, [input, ...buttons]), hint].filter(Boolean));
}

/** The website group: one box per URL the item has, and her "Add website". */
function vurls(ctx) {
  const rows = el("div", {});
  const add = () => {
    const input = el("input", { class: "inp", attrs: { type: "text", spellcheck: "false", placeholder: "https://" } });
    input.addEventListener("input", () => ctx.onChange?.());
    ctx.urlInputs.push(input);
    rows.appendChild(el("div", { class: "field span2" }, [el("div", { class: "inwrap" }, [input])]));
    return input;
  };
  const existing = ctx.item ? ctx.item.urls || [] : [];
  if (existing.length === 0) add();
  else for (const url of existing) add().value = url;

  const more = el("button", { class: "add-link", attrs: { type: "button" } }, [vsvg("PLUS", "2"), el("span", { text: " Add website" })]);
  more.addEventListener("click", () => add().focus());
  return el("div", { class: "group" }, [
    el("div", { class: "group-h", text: "Website (URI) " }, [el("span", { class: "req", text: "*" })]),
    rows,
    more,
  ]);
}

/** Every group of a type's form, built once and shared by the sheet and the row. */
function vformBody(type, item, onChange) {
  const spec = VAULT_TYPES[type];
  const ctx = { item, saved: !!(item && item.id), inputs: {}, urlInputs: [], onChange };
  const name = vfield(
    { key: "name", label: "Item name", required: true, placeholder: spec.placeholder },
    { ...ctx, item: item ? { ...item, fields: { ...item.fields, name: item.name } } : null },
  );
  const nameInput = name.querySelector("input");
  ctx.inputs.name = nameInput;

  const groups = spec.groups.map((group) =>
    group.urls
      ? vurls(ctx)
      : el("div", { class: "group" }, [
          el("div", { class: "group-h", text: group.head }),
          el("div", { class: "grid2" }, group.fields.map((f) => vfield(f, ctx))),
        ]),
  );
  return { nodes: [name, ...groups], ctx };
}

/** What the form sends: only what it holds, and a secret only when it has one. */
function vpayload(type, ctx) {
  const payload = { type, name: ctx.inputs.name.value.trim() };
  for (const group of VAULT_TYPES[type].groups) {
    if (group.urls) {
      payload.urls = ctx.urlInputs.map((i) => i.value.trim()).filter(Boolean);
      continue;
    }
    for (const field of group.fields) {
      const value = ctx.inputs[field.key].value;
      // Blank secret means "leave the stored one alone"; blank anything else
      // means the owner cleared it.
      if (field.secret && !value) continue;
      payload[field.key] = value;
    }
  }
  return payload;
}

/** Her confirm card, for the one action that cannot be undone here. */
function vconfirm(title, body, confirmLabel, onConfirm) {
  const overlay = el("div", { class: "overlay confirm-overlay show" });
  const close = () => overlay.remove();
  const keep = el("button", { class: "btn ghost", attrs: { type: "button" }, text: "Cancel" });
  keep.addEventListener("click", close);
  const go = el("button", { class: "btn danger", attrs: { type: "button" }, text: confirmLabel });
  go.addEventListener("click", async () => {
    go.disabled = true;
    await onConfirm();
    close();
  });
  overlay.appendChild(el("div", { class: "confirm-card", attrs: { role: "alertdialog" } }, [
    el("div", { class: "confirm-h", text: title }),
    el("p", { class: "confirm-p", text: body }),
    el("div", { class: "confirm-acts" }, [keep, go]),
  ]));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.querySelector(".vaultui").appendChild(overlay);
}

/** One saved item: her row, and the form it opens into. */
function vitem(summary, reload) {
  const type = summary.type || "login";
  const spec = VAULT_TYPES[type];
  const article = el("article", { class: "vitem", attrs: { "data-type": type } });

  const row = el("button", { class: "vrow", attrs: { type: "button" } }, [
    el("span", { class: "vicon" }, [vsvg(spec.icon)]),
    el("span", { class: "vmain" }, [
      el("span", { class: "vtitle", text: summary.title || "(untitled)" }),
      el("span", { class: "vctx", text: [summary.subtitle, (summary.urls || [])[0]].filter(Boolean).join(" · ") }),
    ]),
    el("span", { class: "vtag", text: spec.label }),
    el("span", { class: "vchev" }, [vsvg("CHEV", "2")]),
  ]);
  const inner = el("div", { class: "vbody-inner" });
  const body = el("div", { class: "vbody" }, [inner]);

  let loaded = false;
  row.addEventListener("click", async () => {
    article.classList.toggle("open");
    if (loaded || !article.classList.contains("open")) return;
    loaded = true;
    inner.replaceChildren(el("p", { class: "use-note", text: "Opening…" }));
    try {
      const item = await window.domo.vaultItem(summary.id);
      const { nodes, ctx } = vformBody(type, item);
      const del = el("button", { class: "btn danger", attrs: { type: "button" }, text: "Delete" });
      del.addEventListener("click", () =>
        vconfirm(
          "Delete this item?",
          `"${item.name}" goes to the vault's trash. Agents lose it immediately, and anything filled with it stops working.`,
          "Delete",
          async () => {
            try {
              await window.domo.vaultDeleteItem(item.id);
              vtoast("Deleted");
              await reload();
            } catch (err) {
              vtoast("Could not delete it: " + errText(err));
            }
          },
        ),
      );
      const save = el("button", { class: "btn save", attrs: { type: "button" }, text: "Save" });
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          await window.domo.vaultSaveItem({ ...vpayload(type, ctx), itemId: item.id });
          vtoast("Saved");
          await reload();
          return;
        } catch (err) {
          vtoast("Could not save it: " + errText(err));
        }
        save.disabled = false;
      });
      inner.replaceChildren(...nodes, el("div", { class: "vfoot" }, [
        el("span", { class: "use-note" }, [vsvg("SHIELD"), el("span", { text: " Used by agents on approval" })]),
        el("span", { class: "acts" }, [del, save]),
      ]));
    } catch (err) {
      loaded = false;
      inner.replaceChildren(el("p", { class: "use-note", text: "Could not open it: " + errText(err) }));
    }
  });

  article.replaceChildren(row, body);
  return article;
}

/** Her sheet: pick a type, fill that type's form, save. */
function vsheet(reload) {
  const overlay = el("div", { class: "overlay show" });
  const close = () => overlay.remove();

  const title = el("h2", { text: "New item" });
  const tag = el("span", { class: "htag", attrs: { hidden: "" } });
  const back = el("button", { class: "sheet-back", attrs: { type: "button", title: "Back", hidden: "" } }, [vsvg("CHEV", "2.2")]);
  const x = el("button", { class: "sheet-x", attrs: { type: "button", title: "Close" } }, [vsvg("CLOSE", "2.2")]);
  x.addEventListener("click", close);

  const bodyEl = el("div", { class: "sheet-body" });
  const cancel = el("button", { class: "btn ghost", attrs: { type: "button" }, text: "Cancel" });
  cancel.addEventListener("click", close);
  const save = el("button", { class: "btn save", attrs: { type: "button" }, text: "Save" });
  const foot = el("div", { class: "sheet-foot", attrs: { hidden: "" } }, [
    el("span", { class: "req-note" }, [el("span", { class: "req", text: "*" }), el("span", { text: " Required" })]),
    cancel,
    save,
  ]);

  const picker = () => {
    title.textContent = "New item";
    tag.setAttribute("hidden", "");
    back.setAttribute("hidden", "");
    foot.setAttribute("hidden", "");
    bodyEl.replaceChildren(
      el("p", { class: "sheet-sub", text: "What are you saving to the vault?" }),
      el("div", { class: "picker-grid" }, Object.entries(VAULT_TYPES).map(([key, spec]) => {
        const button = el("button", { class: "ptype", attrs: { type: "button", "data-new": key } }, [
          el("span", { class: "pi" }, [vsvg(spec.icon)]),
          el("span", {}, [
            el("span", { class: "pn", text: spec.label }),
            el("span", { class: "pd", text: PTYPE_BLURB[key] }),
          ]),
        ]);
        button.addEventListener("click", () => form(key));
        return button;
      })),
    );
  };

  const form = (type) => {
    title.textContent = "New " + VAULT_TYPES[type].label.toLowerCase();
    tag.textContent = VAULT_TYPES[type].label;
    tag.removeAttribute("hidden");
    back.removeAttribute("hidden");
    foot.removeAttribute("hidden");
    const { nodes, ctx } = vformBody(type, null);
    bodyEl.replaceChildren(el("form", { class: "sheet-form", attrs: { autocomplete: "off" } }, nodes));
    save.onclick = async () => {
      save.disabled = true;
      try {
        await window.domo.vaultSaveItem(vpayload(type, ctx));
        close();
        vtoast("Saved");
        await reload();
        return;
      } catch (err) {
        vtoast("Could not save it: " + errText(err));
      }
      save.disabled = false;
    };
  };
  back.addEventListener("click", picker);

  overlay.appendChild(el("div", { class: "sheet", attrs: { role: "dialog", "aria-modal": "true" } }, [
    el("div", { class: "sheet-top" }, [back, el("div", { class: "sheet-titlewrap" }, [title, tag]), x]),
    bodyEl,
    foot,
  ]));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  picker();
  document.querySelector(".vaultui").appendChild(overlay);
}

/** Her one-line description of each type, on the picker cards. */
const PTYPE_BLURB = {
  login: "Username, password & 2FA for a site",
  card: "Payment card for checkout",
  identity: "Name, address & contact details",
  note: "Freeform private text",
};

async function renderVault() {
  // Everything the vault holds, edited here. This is why the tab exists: the
  // only other way in is the vault's own web page, and reaching it means a
  // browser warning about the certificate the app issued to itself.
  let items = null;
  let failure = "";
  try {
    items = await window.domo.vaultItems();
  } catch (err) {
    failure = errText(err);
  }

  const pane = el("div", { class: "vaultui" });
  const masthead = el("div", { class: "masthead" }, [
    el("div", {}, [
      el("h1", { text: "Vault" }),
      el("p", { class: "trust" }, [
        el("span", { text: "Your agents can use these to act for you. " }),
        el("span", { class: "lk", text: "They never see the raw values" }),
        el("span", { text: " — every use needs your approval and is logged." }),
      ]),
    ]),
  ]);

  if ((items === null || (items && items.locked)) && !failure) {
    // Locked and empty are different facts and get different words. A vault
    // whose key has moved — a Keychain reset, a Mac restored from backup — used
    // to render as "has not started yet", which sent people looking for a
    // server that was running fine.
    const locked = !!(items && items.locked);
    pane.replaceChildren(masthead, el("div", { class: "col" }, [
      el("div", { class: "empty", text: locked
        ? "This Mac can't unlock its vault account."
        : "The vault has not started yet." }),
      // No invented recovery, and no asserting a cause the code cannot tell
      // apart: `undecryptable` is one `catch` covering a wrong key AND a
      // damaged file, so the copy leads with what is certain, names the likely
      // cause as likely, and gives the remedy — the same either way.
      locked
        ? el("p", { class: "use-note", text: items.reason === "no-storage"
            ? "The encrypted account is on disk, but this build has no secure storage to open it with. Nothing is lost; a build with secure storage will read it."
            : "The account file is present but cannot be opened. Usually that means the key is no longer in this Mac's Keychain — after a Keychain reset, a restore from backup, or a change to how the app identifies itself — and it can also mean the file itself is damaged. Either way the password cannot be recovered, here or anywhere: the vault would have to be set up again. Nothing has been deleted." })
        : null,
    ].filter(Boolean)));
    view.replaceChildren(pane);
    return;
  }

  const newBtn = el("button", { class: "btn-primary", attrs: { type: "button" } }, [
    vsvg("PLUS", "2.2"),
    el("span", { text: " New" }),
  ]);
  newBtn.addEventListener("click", () => vsheet(renderVault));
  masthead.appendChild(newBtn);

  const list = el("div", { class: "vlist" });
  if (failure) {
    list.replaceChildren(el("div", { class: "empty", text: "Could not read the vault: " + failure }));
  } else if (items.length === 0) {
    list.replaceChildren(el("div", { class: "empty", text: "Nothing saved yet." }));
  } else {
    list.replaceChildren(...items.map((i) => vitem(i, renderVault)));
  }

  const count = failure ? "" : `${items.length} item${items.length === 1 ? "" : "s"}`;
  pane.replaceChildren(
    masthead,
    el("div", { class: "col" }, [
      el("div", { class: "list-head" }, [
        el("span", { class: "lt", text: "Saved items" }),
        el("span", { class: "lc", text: count }),
      ]),
      list,
    ]),
    el("div", { class: "toast" }),
  );
  view.replaceChildren(pane);
}

async function renderSettings() {
  // The Plow account. There is no credential field and no URL field here: the
  // credential is minted by first-run login and never leaves the main process,
  // and the API origin is baked into the build (a token is only valid against
  // the environment that minted it, so an editable origin could only be wrong).
  const relay = await window.domo.relayGet();
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
    accountBox.replaceChildren(
      ...(relay.hasCredential
        ? [
            el("div", { class: "field" }, [
              el("label", { text: "Agent endpoint" }),
              el("div", { class: "mono faint", text: relay.mcpUrl || "—" }),
            ]),
            el("div", { class: "field" }, [
              el("label", { text: "Account" }),
              el("div", { class: "mono faint", text: relay.accountUid || "—" }),
            ]),
          ]
        : []),
    );
  };
  await refreshAccount();

  // Software updates: version + status + a check/restart action + the two
  // automation preferences. Everything renders from one updates:get shape.
  const u = await window.domo.updatesGet();
  const updateStatus = el("p", { class: "faint", text: updateStatusText(u) });
  const updateAction =
    u.phase === "ready"
      ? el("button", { class: "btn primary", text: "Restart to Update" })
      : el("button", { class: "btn", text: "Check for Updates" });
  updateAction.disabled = !u.supported || u.phase === "checking" || u.phase === "downloading";
  updateAction.addEventListener("click", async () => {
    if (u.phase === "ready") await window.domo.updatesRestart();
    else await window.domo.updatesCheck();
    // The controller's change events re-render this screen as the check runs.
  });
  const autoCheckBox = el("input", { attrs: { type: "checkbox" } });
  autoCheckBox.checked = u.autoCheck;
  autoCheckBox.disabled = !u.supported;
  autoCheckBox.addEventListener("change", () => window.domo.updatesSetAutoCheck(autoCheckBox.checked));
  const autoCheckLabel = el("label", { class: "check block" + (u.supported ? "" : " disabled") }, [
    autoCheckBox,
    el("span", { text: "Automatically check for updates" }),
  ]);
  const autoInstallBox = el("input", { attrs: { type: "checkbox" } });
  autoInstallBox.checked = u.autoInstall;
  autoInstallBox.disabled = !u.supported;
  autoInstallBox.addEventListener("change", () => window.domo.updatesSetAutoInstall(autoInstallBox.checked));
  const autoInstallLabel = el("label", { class: "check block" + (u.supported ? "" : " disabled") }, [
    autoInstallBox,
    el("span", { text: "Install downloaded updates when quitting Plow" }),
  ]);

  const restoreNote = el("p", { class: "faint", text: "" });
  const restore = el("button", { class: "btn", text: "Restore Default Goals" });
  restore.addEventListener("click", async () => {
    await window.domo.goalsRestoreDefaults();
    restoreNote.textContent = "Default goals restored.";
  });

  // Anthropic API key — one of the two ways to power the adversarial agent.
  const apiKeyInput = el("input", { class: "text", attrs: { type: "password", placeholder: "sk-ant-…" } });
  apiKeyInput.value = await window.domo.apiKeyGet();

  // Which backend runs the reviewer. `inference` carries a per-provider
  // availability map and the active model — never a credential.
  let inference = await window.domo.inferenceGet();
  const reviewerNote = el("p", { class: "faint reviewer-note", text: "" });
  const providerChips = el("div", { class: "chips" });
  // Labels are the only provider knowledge left here; which providers exist,
  // and whether each is usable, comes from main.
  const PROVIDER_LABELS = { plow: "Plow account", anthropic: "Anthropic API key" };

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
  const suggestLabel = el("label", { class: "check" }, [
    suggestCheck,
    el("span", { text: "Show Adversarial Agent suggestions in Ask mode" }),
  ]);
  suggestCheck.addEventListener("change", () => window.domo.showSuggestionsSet(suggestCheck.checked));

  // Adversarial Agent needs an API key; the suggestions checkbox needs Ask mode
  // AND a key. Re-render whenever the mode or key presence changes.
  const renderModeChips = () => {
    modeChips.replaceChildren(...MODES.map(([value, label]) => {
      const disabled = value === "adversarial" && !hasKey;
      const chip = el("span", {
        class: "chip" + (currentMode === value ? " active" : "") + (disabled ? " disabled" : ""),
      }, [el("span", { text: label })]);
      if (!disabled) {
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

  // A provider with no credential is disabled and cannot be selected; the main
  // process enforces the same rule, this only keeps the UI honest.
  const renderProviderChips = () => {
    reviewerNote.textContent = `Reviewer: ${inference.info}`;
    providerChips.replaceChildren(...Object.entries(inference.available).map(([value, usable]) => {
      const label = PROVIDER_LABELS[value] ?? value;
      const disabled = !usable;
      const chip = el("span", {
        class:
          "chip" +
          (inference.provider === value ? " active" : "") +
          (disabled ? " disabled" : ""),
      }, [el("span", { text: label })]);
      if (!disabled && inference.provider !== value) {
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
    },
  };

  view.replaceChildren(el("div", { class: "panel settings" }, [
    group("Plow Account", "Sign in with your phone number to let agents reach this Mac.", [
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
      suggestLabel,
    ]),
    group("Goals", "Re-add any default goals you've removed.", [
      el("div", { class: "row" }, [restore, restoreNote]),
    ]),
    group("Software Updates", `Version ${u.currentVersion}`, [
      el("div", { class: "row" }, [updateStatus, el("div", { class: "spacer" }), updateAction]),
      autoCheckLabel,
      autoInstallLabel,
    ]),
  ]));
}

function render() {
  if (currentTab === "agents") renderAgents();
  else if (currentTab === "audit") renderAudit();
  else if (currentTab === "goals") renderGoals();
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
  if (currentTab === "settings") renderSettings();
});
// The menu-bar "Check for Updates…" lands here so its outcome is visible.
window.domo.onShowSettings(() => selectTab("settings"));

// Restore the last-selected tab (falls back to the HTML default on any miss).
async function boot() {
  refreshStatus();
  refreshUpdateBanner();
  const saved = await window.domo.uiGetTab();
  const known = ["agents", "goals", "audit", "rules", "vault", "settings"];
  selectTab(known.includes(saved) ? saved : "audit");
}
boot();
