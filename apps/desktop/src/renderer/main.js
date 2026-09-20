/* Main-window renderer. Sandboxed: no Node, no ipcRenderer — only the narrow
   `window.domo` bridge from preload. All agent-derived text is inserted with
   textContent (never innerHTML), so nothing on the wire can inject markup. */

import {
  PURPOSE_PLACEHOLDER,
} from "./approvals.js";
import { attentionMatches, createSerialAutosave, modeView } from "./gatekeeperState.js";

import { el, icon, switchEl } from "./dom.js";
import { singleFlight } from "./onboardingAction.js";
import { renderVault, vaultConfirmLeave } from "./vault.js";
import {
  agentKind,
  cloudErrorCopy,
  cloudProviderPickerViewModel,
  deployCards,
} from "../cloudAgentViewModel.js";

const view = document.getElementById("view");
const seg = document.getElementById("seg");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

// Null until boot() picks one: the HTML marks Audit active for the first paint,
// but boot must still RENDER that pane, and "already on this tab" now returns
// early — so the starting value cannot be a tab boot might legitimately select.
let currentTab = null;
// The Audit tab's two filters, one per column (viewModel.ts DecisionKind /
// StatusKind). "any" is no filter.
let decisionFilter = "any";
let statusFilter = "any";
const DECISION_FILTERS = [
  ["any", "Any"], ["allowed", "Allowed"], ["denied", "Denied"], ["unanswered", "Unanswered"],
];
const STATUS_FILTERS = [
  ["any", "Any"], ["completed", "Completed"], ["running", "Running"], ["blocked", "Blocked"], ["failed", "Failed"],
];
// The Date filter: rows at or after a cutoff. The presets are relative to
// now; "since" is a fixed moment set by the Permissions section's "Show in
// Audit" (the dismissal its count starts from) and listed in the menu only
// while it is set.
let dateFilter = "any";
let dateSince = null;
const DATE_FILTERS = [
  ["any", "Any time"], ["1h", "Last hour"], ["today", "Today"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"],
];
function dateCutoff(now = Date.now()) {
  switch (dateFilter) {
    case "1h": return now - 3_600_000;
    case "today": { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
    case "24h": return now - 24 * 3_600_000;
    case "7d": return now - 7 * 86_400_000;
    case "30d": return now - 30 * 86_400_000;
    case "since": return dateSince ? new Date(dateSince).getTime() : null;
    default: return null;
  }
}
function sinceLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Since…";
  // To the second, like the Time column: the cutoff is exact and the rows
  // either side of it are often seconds apart.
  return `Since ${d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
}
// The mounted Settings pane, while that tab is up. Holds a `refresh` that
// updates the display nodes in place, so a relay reconnect cannot reset the
// pane under someone reading it.
let settingsMounted = null;
let settingsRenderGeneration = 0;

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

const gatekeeperNotice = document.getElementById("gatekeeperNotice");
let gatekeeperAttention = null;
let gatekeeperAttentionGeneration = 0;

async function dismissGatekeeperRecovery(intentId) {
  gatekeeperAttention = await window.domo.gatekeeperRecoveryDismiss(intentId);
  drawGatekeeperNotice();
  if (currentTab === "audit") await refreshAudit({ changed: new Set([selectedId].filter(Boolean)) });
}

async function showGatekeeperRecovery(attention = gatekeeperAttention) {
  if (!attention) return;
  if (currentTab !== "audit" && !(await selectTab("audit"))) return;
  const page = await window.domo.auditPage({
    limit: 200,
    search: "",
    decision: "any",
    status: "any",
    cutoffMs: null,
    cutoffKey: "ts",
    keepId: selectedId,
  });
  const activity = page.rows.find((row) => row.intentId === attention.intentId);
  if (activity) selectedId = activity.id;
  await refreshAudit({ changed: new Set(activity ? [activity.id] : ["*"]) });
  if (activity) auditMounted?.rows.get(activity.id)?.tr.scrollIntoView({ block: "center" });
  auditMounted?.detailScroll.focus({ preventScroll: true });
}

function drawGatekeeperNotice() {
  gatekeeperNotice.hidden = !gatekeeperAttention || currentTab === "audit";
  gatekeeperNotice.replaceChildren();
  if (gatekeeperNotice.hidden) return;
  const attention = gatekeeperAttention;
  const review = el("button", { class: "btn", text: "Review in Audit →" });
  review.addEventListener("click", () => void showGatekeeperRecovery(attention));
  const dismiss = el("button", {
    class: "gatekeeper-notice-dismiss",
    text: "×",
    attrs: { type: "button", "aria-label": "Dismiss Gatekeeper denial" },
  });
  dismiss.addEventListener("click", () => void dismissGatekeeperRecovery(attention.intentId));
  gatekeeperNotice.append(
    el("span", { class: "gatekeeper-notice-mark", text: "!" }),
    el("div", { class: "gatekeeper-notice-copy" }, [
      el("strong", { text: "Gatekeeper denied a request" }),
      el("span", { text: attention.request }),
    ]),
    review,
    dismiss,
  );
}

async function refreshGatekeeperAttention() {
  const generation = ++gatekeeperAttentionGeneration;
  const attention = await window.domo.gatekeeperRecoveryGet();
  if (generation !== gatekeeperAttentionGeneration) return;
  gatekeeperAttention = attention;
  drawGatekeeperNotice();
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
// The listing is paged from main's live index: this many rows at a time,
// more as the list is scrolled. The count starts over for a new filter set.
const AUDIT_PAGE = 200;
let auditLimit = AUDIT_PAGE;
let auditQueryKey = null;
// The selected row with its timeline, as last fetched — refetched when the
// selection moves or a live change touched that row.
let auditDetail = { id: null, activity: null };
let auditRenderGeneration = 0;

// Times are formatted here, at draw time, from the ISO stamps the rows carry.
// One formatter per shape, built once: the locale lookup behind each call is
// the expensive part, and the old per-step call in the main process was most
// of what it spent on the log.
const DAY_TIME_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
});
const CLOCK_FMT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
function fmtWith(fmt, iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : fmt.format(d);
}
const fmtDayTime = (iso) => fmtWith(DAY_TIME_FMT, iso);
const fmtClock = (iso) => fmtWith(CLOCK_FMT, iso);

// Mount the audit chrome once (search input, chips, list + detail containers).
async function renderAudit() {
  const generation = ++auditRenderGeneration;
  await refreshGatekeeperAttention();
  if (currentTab !== "audit" || generation !== auditRenderGeneration) return;
  const gatekeeper = createGatekeeperCard();
  const search = el("div", { class: "search" }, [
    el("input", { attrs: { placeholder: "Search activity, path, agent…" } }),
  ]);
  const searchInput = search.querySelector("input");
  searchInput.value = auditSearch;
  searchInput.addEventListener("input", () => { auditSearch = searchInput.value; refreshAudit(); });

  // Two popup buttons, one per column; each reads "Decision" until a value
  // is picked, then "Decision: Allowed". Rebuilt on every refresh.
  const chipsBox = el("div", { class: "chips" });
  const count = el("span", { class: "count" });
  const clearBtn = el("button", { class: "btn small", text: "Clear Log" });
  clearBtn.addEventListener("click", async () => {
    const cleared = await window.domo.auditClear();
    if (cleared) {
      selectedId = null;
      auditDetail = { id: null, activity: null };
      refreshAudit({ changed: new Set(["*"]) });
    }
  });
  const toolbar = el("div", { class: "toolbar" }, [
    search, chipsBox, el("div", { class: "spacer" }), count, clearBtn,
  ]);

  const listBox = el("div", { class: "list" });
  // The line under the last loaded row while there are more; nearing it
  // asks main for the next page. Asked once per page: a further scroll
  // while that read is in flight finds the limit already past the rows.
  const moreBox = el("div", { class: "empty", attrs: { hidden: "" } });
  auditLimit = AUDIT_PAGE;
  auditQueryKey = null;
  // Live changes are not followed while another tab is up, so a detail
  // cached before leaving may be behind the row it sits beside on return.
  // Start clean: the first refresh reads the selected row again.
  auditDetail = { id: null, activity: null };
  listBox.addEventListener("scroll", () => {
    const m = auditMounted;
    if (!m || m.listBox !== listBox) return;
    if (m.total <= m.rows.size || auditLimit > m.rows.size) return;
    if (listBox.scrollTop + listBox.clientHeight < listBox.scrollHeight - 300) return;
    auditLimit += AUDIT_PAGE;
    refreshAudit();
  });
  // The detail pane is a column: the activity info scrolls in .detail-scroll;
  // the live browser thumbnail sits pinned below it, outside the scroll.
  const detailScroll = el("div", { class: "detail-scroll", attrs: { tabindex: "-1" } });
  const liveImg = el("img", { attrs: { alt: "Live browser view" } });
  const liveDot = el("span", { class: "dot" });
  const liveCapText = el("span");
  const liveHint = el("span", { class: "live-hint" });
  // A REAL BUTTON, because the picture IS the control: a div with a click
  // handler works for a pointer and leaves a keyboard with nothing to reach.
  // Its label carries the state, since the visual hint is off screen most of
  // the time and decorative when it is not.
  const liveShot = el("button", { class: "live-shot", attrs: { type: "button" } }, [
    liveImg,
    liveHint,
  ]);
  const liveBox = el("div", { class: "live-corner hidden" }, [
    liveShot,
    el("div", { class: "live-cap" }, [liveDot, liveCapText]),
  ]);

  /** How long the enlarged hint stays before it fades. */
  const HINT_MS = 1000;
  let hintTimer = null;

  const syncLabel = () => {
    const big = liveBox.classList.contains("expanded");
    liveShot.setAttribute("aria-label", (big ? "Minimize" : "Enlarge") + " live browser view");
  };
  const hideHint = () => {
    clearTimeout(hintTimer);
    liveHint.classList.remove("on");
  };
  const showHint = (text, timed) => {
    clearTimeout(hintTimer);
    liveHint.textContent = text;
    liveHint.classList.add("on");
    if (timed) hintTimer = setTimeout(() => liveHint.classList.remove("on"), HINT_MS);
  };
  syncLabel();

  // Small: the hint follows hover. Expanded: it fades after HINT_MS even if
  // still hovered — the clock starts on arrival, and mouse-out does not dismiss
  // it, or leaving would almost always beat the timer.
  liveShot.addEventListener("mouseenter", () => {
    if (liveBox.classList.contains("expanded")) showHint("Click to minimize", true);
    else showHint("Click to enlarge", false);
  });
  liveShot.addEventListener("mouseleave", () => {
    if (!liveBox.classList.contains("expanded")) hideHint();
  });

  // Click the thumbnail to blow it up over the window; click again (anywhere on
  // the blown-up view) to shrink it back to the corner.
  liveBox.addEventListener("click", () => {
    const big = liveBox.classList.toggle("expanded");
    syncLabel();
    // Opening the panel IS the arrival its hint answers to: the pointer is
    // already inside after the click, so no mouseenter follows.
    if (big) showHint("Click to minimize", true);
    else hideHint();
  });
  const detailBox = el("aside", { class: "detail" }, [detailScroll, liveBox]);
  detailBox.style.width = detailWidth + "px";
  const splitter = el("div", { class: "splitter", attrs: { title: "Drag to resize" } });
  wireSplitter(splitter, detailBox);
  view.replaceChildren(gatekeeper.node, toolbar, el("div", { class: "a1" }, [listBox, splitter, detailBox]));

  // The table (and its tbody) persist across refreshes so row nodes are reused,
  // not rebuilt — that keeps an in-progress insert animation alive and lets a
  // burst of streamed events update a row in place instead of recreating it.
  const tbody = el("tbody");
  const table = el("table", {}, [
    el("thead", {}, [el("tr", {}, [
      el("th", { text: "Time" }), el("th", { text: "Decision" }), el("th", { text: "Status" }), el("th", { text: "Activity" }),
    ])]),
    tbody,
  ]);

  auditMounted = {
    listBox, detailScroll, count, chipsBox, clearBtn, searchInput, table, tbody, rows: new Map(),
    moreBox, total: 0,
    liveBox, liveImg, liveDot, liveCapText, hideHint, syncLabel, liveHasFrame: false,
    gatekeeper,
  };
  await gatekeeper.ready;
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
// `opts.changed` is the set of row ids a live change touched ("*" for all of
// them), so the selected row's timeline is refetched only when it moved.
//
// One refresh at a time: live changes arriving while one is in flight fold
// into a single follow-up, not a pile of overlapping reads.
let auditRefreshing = false;
let auditRefreshQueued = null;
async function refreshAudit(opts = {}) {
  if (!auditMounted) return;
  if (auditRefreshing) {
    const queued = auditRefreshQueued ?? { followTop: false, changed: new Set() };
    queued.followTop = queued.followTop || !!opts.followTop;
    for (const id of opts.changed ?? []) queued.changed.add(id);
    auditRefreshQueued = queued;
    return;
  }
  auditRefreshing = true;
  try {
    await refreshAuditNow(opts);
  } finally {
    auditRefreshing = false;
    if (auditRefreshQueued !== null) {
      const next = auditRefreshQueued;
      auditRefreshQueued = null;
      void refreshAudit(next);
    }
  }
}

async function refreshAuditNow(opts) {
  const mounted = auditMounted;
  const { listBox, detailScroll, count, chipsBox, clearBtn, searchInput, table, tbody, rows, moreBox } = mounted;
  const q = auditSearch.trim().toLowerCase();
  const cutoff = dateCutoff();
  // A new result set starts at the first page; the same one keeps what was
  // scrolled into view. Keyed on the settings, not the computed cutoff: a
  // relative preset's cutoff moves with the clock, and keying on it made
  // every scroll refresh look like a new filter set, snapping back to page one.
  const key = JSON.stringify([q, decisionFilter, statusFilter, dateFilter, dateSince]);
  if (key !== auditQueryKey) {
    auditQueryKey = key;
    auditLimit = AUDIT_PAGE;
  }
  // Main filters and pages from its live index: the rows this view matches,
  // without their timelines. The search is the same match
  // viewModel.activityMatches makes — title, command, agent, goal, the
  // permission a block named, and the timeline lines.
  const page = await window.domo.auditPage({
    limit: auditLimit,
    search: auditSearch,
    decision: decisionFilter,
    status: statusFilter,
    cutoffMs: cutoff,
    // The Permissions section counts by the block's own time, so its cutoff
    // keys on that; the presets key on when the row began.
    cutoffKey: dateFilter === "since" ? "blocked" : "ts",
    // The selected row stays loaded even when new activity above it pushes
    // it past the page; the window grows through it and stays grown.
    keepId: selectedId,
  });
  if (auditMounted !== mounted) return; // the tab was left meanwhile
  const shown = page.rows;
  if (shown.length > auditLimit) auditLimit = shown.length;
  mounted.total = page.total;
  clearBtn.disabled = page.size === 0;
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
  // The detail pane's row, timeline and all — one read, for the selected row
  // only, and only when the selection or that row itself changed.
  const changed = opts.changed ?? new Set();
  let selected = null;
  if (selectedId !== null) {
    if (auditDetail.id !== selectedId || changed.has(selectedId) || changed.has("*")) {
      // The id is captured before the read: a click on another row while
      // this one is in flight moves `selectedId`, and the answer must be
      // cached under the row it is for — the queued refresh then sees the
      // mismatch and reads the new selection.
      const wanted = selectedId;
      const activity = await window.domo.auditActivity(wanted);
      if (auditMounted !== mounted) return;
      auditDetail = { id: wanted, activity };
    }
    selected = auditDetail.id === selectedId ? auditDetail.activity : null;
  }

  const filterButton = (name, options, current, set) => {
    const label = options.find(([key]) => key === current)?.[1] ?? "Any";
    const active = current !== "any";
    const btn = el("button", {
      class: "chip filter-btn" + (active ? " active" : ""),
      attrs: { type: "button", "aria-haspopup": "menu" },
    }, [
      el("span", { text: active ? `${name}: ${label}` : name }),
      el("span", { class: "filter-caret", text: "▾" }),
    ]);
    btn.addEventListener("click", () => {
      openMenu(btn, options.map(([key, text]) => ({
        label: text,
        checked: key === current,
        run: () => { set(key); refreshAudit(); },
      })), { align: "left" });
    });
    return btn;
  };
  // "Clear" shows only while something narrows the list, and resets all of
  // it: both filters and the search box.
  const filtering = !!q || decisionFilter !== "any" || statusFilter !== "any" || dateFilter !== "any";
  const clearFilters = el("button", { class: "cap-more filter-clear", text: "Clear", attrs: { type: "button" } });
  clearFilters.addEventListener("click", () => {
    decisionFilter = "any";
    statusFilter = "any";
    dateFilter = "any";
    dateSince = null;
    auditSearch = "";
    searchInput.value = "";
    refreshAudit();
  });
  const dateOptions = dateSince ? [...DATE_FILTERS, ["since", sinceLabel(dateSince)]] : DATE_FILTERS;
  chipsBox.replaceChildren(
    filterButton("Decision", DECISION_FILTERS, decisionFilter, (k) => { decisionFilter = k; }),
    filterButton("Status", STATUS_FILTERS, statusFilter, (k) => { statusFilter = k; }),
    filterButton("Date", dateOptions, dateFilter, (k) => { dateFilter = k; }),
    ...(filtering ? [clearFilters] : []),
  );
  const total = page.total;
  count.textContent = `${total} ${total === 1 ? "activity" : "activities"}`;

  // Empty state — no rows to reconcile; drop any cached row nodes.
  if (!shown.length) {
    rows.clear();
    tbody.replaceChildren();
    listBox.replaceChildren(el("div", { class: "empty", text: filtering ? "No matching activity." : "No activity yet." }));
    detailScroll.replaceChildren(detailFor(selected));
    return;
  }
  if (listBox.firstChild !== table) listBox.replaceChildren(table, moreBox);
  // What is not on screen yet: scrolling to the bottom loads the next page.
  moreBox.hidden = shown.length >= total;
  moreBox.textContent = `Showing ${shown.length} of ${total} — scroll for more`;

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
    if (!s.active) {
      m.liveHasFrame = false; // next session starts with a fresh frame
      m.liveBox.classList.remove("expanded"); // never leave the overlay up with no session
      m.hideHint();
      m.syncLabel();
    }
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
  const decisionCw = el("div", { class: "cw" });
  const badgeCw = el("div", { class: "cw" });
  const iconWrap = el("span", { class: "ic-wrap" });
  const titleSpan = el("span", { class: "t-title" });
  const actCw = el("div", { class: "cw" }, [el("div", { class: "t-act" }, [iconWrap, titleSpan])]);
  const tr = el("tr", {}, [
    el("td", { class: "t-time" }, [timeCw]),
    el("td", {}, [decisionCw]),
    el("td", { class: "t-dec" }, [badgeCw]),
    el("td", {}, [actCw]),
  ]);
  // Select on mouse down (feels immediate, before the click completes).
  tr.addEventListener("mousedown", () => { selectedId = id; refreshAudit(); });
  return {
    tr, timeCw, decisionCw, badgeCw, iconWrap, titleSpan,
    time: null, decision: null, decisionTone: null, tone: null, status: null, title: null, kind: null,
  };
}

// The Decision cell: who let this happen, as a pill — without the dot the
// other tabs' pills carry, since the fill already says it. Empty for a row
// that had no authorization step.
function decisionMark(a) {
  if (!a.decision) return el("span", { class: "dec-none" });
  return el("span", { class: `badge b-${a.decisionTone || "zinc"}`, text: a.decision });
}

// The Status cell: what happened to the work, as a colored word rather than
// a second pill. Empty when nothing ran.
function statusPill(a) {
  if (!a.status) return el("span", { class: "dec dec-none" });
  return el("span", { class: `dec dec-${a.tone || "zinc"}`, text: a.status });
}

// Update a row's content in place, touching only what changed.
function updateAuditRow(r, a) {
  r.tr.classList.toggle("gatekeeper-denied-row", a.decisionKind === "denied");
  if (r.time !== a.ts) { r.timeCw.textContent = fmtDayTime(a.ts); r.time = a.ts; }
  if (r.decisionTone !== a.decisionTone || r.decision !== a.decision) {
    r.decisionCw.replaceChildren(decisionMark(a));
    r.decisionTone = a.decisionTone; r.decision = a.decision;
  }
  if (r.tone !== a.tone || r.status !== a.status) {
    r.badgeCw.replaceChildren(statusPill(a));
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

let gatekeeperSuggestionModal = null;

function closeGatekeeperSuggestionModal() {
  if (!gatekeeperSuggestionModal) return;
  const closing = gatekeeperSuggestionModal;
  gatekeeperSuggestionModal = null;
  closeModal(closing.modal);
}

function openGatekeeperSuggestionModal(trigger, attention) {
  const body = el("div", { class: "gatekeeper-suggestion-body" }, [
    el("div", { class: "gatekeeper-suggestion-loading" }, [
      el("span", { class: "gatekeeper-inline-spinner" }),
      el("span", { text: "Drafting revised instructions…" }),
    ]),
  ]);
  const cancel = el("button", { class: "btn", text: "Cancel" });
  let modal = null;
  cancel.addEventListener("click", closeGatekeeperSuggestionModal);
  modal = openModal(trigger, {
    className: "gatekeeper-suggestion-modal",
    children: [
      el("div", { class: "modal-title-row" }, [
        el("h2", { text: "Suggest revised instructions" }),
        el("div", { class: "spacer" }),
        cancel,
      ]),
      el("div", { class: "gatekeeper-suggestion-context" }, [
        el("strong", { text: "Denied request" }),
        el("div", { class: "mono", text: attention.request }),
        attention.reason ? el("p", { class: "faint", text: `Reviewer: ${attention.reason}` }) : null,
      ]),
      body,
    ],
    onDismiss: closeGatekeeperSuggestionModal,
  });
  if (!modal) return;
  gatekeeperSuggestionModal = { modal, intentId: attention.intentId };

  void Promise.all([
    window.domo.agentPurposeGet(),
    window.domo.gatekeeperRecoverySuggest(attention.intentId),
  ]).then(async ([currentPurpose, result]) => {
    const latest = await window.domo.gatekeeperRecoveryGet();
    if (gatekeeperSuggestionModal?.modal !== modal) return;
    if (latest?.intentId !== attention.intentId) {
      body.replaceChildren(el("p", { class: "warn", text: "A newer Gatekeeper denial replaced this one." }));
      return;
    }
    if (!result?.ok) {
      const retry = el("button", { class: "btn", text: "Try again" });
      retry.addEventListener("click", () => {
        closeGatekeeperSuggestionModal();
        openGatekeeperSuggestionModal(trigger, attention);
      });
      body.replaceChildren(
        el("p", { class: "warn", text: result?.reason || "Gatekeeper could not suggest a revision." }),
        retry,
      );
      return;
    }
    const suggestion = el("textarea", { class: "text gatekeeper-suggestion" });
    suggestion.value = result.revision;
    const save = el("button", { class: "btn primary", text: "Save instructions" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      const saved = await auditMounted?.gatekeeper.savePurpose(suggestion.value);
      if (!saved) {
        save.disabled = false;
        return;
      }
      await dismissGatekeeperRecovery(attention.intentId);
      closeGatekeeperSuggestionModal();
    });
    body.replaceChildren(
      el("div", { class: "field" }, [
        el("label", { text: "Current instructions" }),
        el("div", { class: "gatekeeper-current-purpose", text: currentPurpose || "No instructions yet." }),
      ]),
      el("div", { class: "field" }, [
        el("label", { text: "Suggested replacement" }),
        suggestion,
      ]),
      el("p", { class: "faint", text: "Review and edit this full replacement before saving it." }),
      el("div", { class: "gatekeeper-suggestion-actions" }, [save]),
    );
    suggestion.focus();
  });
}

function gatekeeperDenialDetail(a) {
  if (!attentionMatches(gatekeeperAttention, a)) return null;
  const attention = gatekeeperAttention;
  const dismiss = el("button", {
    class: "gatekeeper-denial-dismiss",
    text: "×",
    attrs: { type: "button", "aria-label": "Dismiss Gatekeeper denial" },
  });
  dismiss.addEventListener("click", () => void dismissGatekeeperRecovery(attention.intentId));
  const suggest = el("button", { class: "btn gatekeeper-suggest", text: "Suggest revised instructions" });
  suggest.addEventListener("click", () => openGatekeeperSuggestionModal(suggest, attention));
  return el("section", { class: "gatekeeper-denial-detail" }, [
    el("div", { class: "gatekeeper-denial-head" }, [
      el("h3", { text: "Gatekeeper denied this request" }),
      el("div", { class: "spacer" }),
      dismiss,
    ]),
    attention.reason ? el("p", { class: "gatekeeper-denial-reason", text: attention.reason }) : null,
    el("p", { text: "Revise Gatekeeper’s instructions if requests like this should be allowed." }),
    suggest,
  ]);
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

  // The header repeats the row's two cells: the decision, then the outcome.
  const children = [
    gatekeeperDenialDetail(a),
    el("h3", { class: "act-head" }, [decisionMark(a), statusPill(a)]),
    a.command ? el("div", { class: "cmd", text: a.command }) : null,
    meta,
  ];
  if (a.capabilities && a.capabilities.length) {
    children.push(el("div", { class: "section-label", text: "Capability bounds" }));
    children.push(el("div", { class: "capchips" }, a.capabilities.map((c) => el("span", { class: "cap", text: String(c) }))));
  }
  if (a.timeline && a.timeline.length) {
    children.push(el("div", { class: "section-label", text: "Timeline" }));
    children.push(el("div", { class: "timeline" }, a.timeline.map((s) =>
      el("div", { class: "tl" + (s.state === "ok" ? " ok" : s.state === "bad" ? " bad" : "") }, [
        el("div", { class: "tt", text: s.text }),
        el("div", { class: "tm", text: fmtClock(s.at) }),
      ]),
    )));
  }
  return el("div", {}, children.filter(Boolean));
}

// ---- Gatekeeper policy (Audit header) ----

const GATEKEEPER_MODES = ["adversarial", "ask", "approve", "deny"];
let rulesModal = null;

function closeRulesModal() {
  if (!rulesModal) return;
  const closing = rulesModal;
  rulesModal = null;
  closeModal(closing.modal);
}

function openRulesModal(trigger) {
  const list = el("div", { class: "rule-list" });
  const close = el("button", { class: "btn", text: "Close" });
  const title = el("h2", { text: "Always-allow rules" });
  let modal = null;

  const draw = (rules) => {
    list.replaceChildren(...(rules.length
      ? rules.map((rule) => {
          const revoke = el("button", { class: "btn danger", text: "Revoke Rule" });
          const failed = el("p", {
            class: "warn",
            text: "Couldn't revoke this rule, so it is still in effect. Try again.",
          });
          failed.hidden = true;
          revoke.addEventListener("click", async () => {
            revoke.disabled = true;
            try {
              await window.domo.rulesRemove(rule.ruleKey);
            } catch {
              failed.hidden = false;
              revoke.disabled = false;
            }
          });
          return el("div", { class: "item rule-item" }, [
            el("div", { class: "row" }, [
              el("h4", { text: rule.agentDisplay || rule.agentId }),
              el("div", { class: "spacer" }),
              revoke,
            ]),
            el("div", { class: "capchips" },
              (rule.capabilities || []).map((capability) =>
                el("span", { class: "cap", text: capText(capability) }))),
            failed,
          ]);
        })
      : [el("div", { class: "empty", text: "No always-allow rules." })]));
    title.textContent = rules.length === 1 ? "1 always-allow rule" : `${rules.length} always-allow rules`;
  };

  const refresh = async () => {
    const rules = await window.domo.rulesList();
    if (rulesModal?.modal === modal) draw(rules);
  };
  close.addEventListener("click", closeRulesModal);
  modal = openModal(trigger, {
    className: "rules-modal",
    children: [
      el("div", { class: "modal-title-row" }, [title, el("div", { class: "spacer" }), close]),
      el("p", {
        class: "faint",
        text: "These agent and capability combinations can run without asking you again. " +
          "Plugin read rules also cover any query following the displayed command prefix.",
      }),
      list,
    ],
    onDismiss: closeRulesModal,
  });
  if (!modal) return;
  rulesModal = { modal, refresh };
  void refresh();
}

function createGatekeeperCard() {
  const modeButton = el("button", {
    class: "gatekeeper-mode",
    text: "Loading…",
    attrs: { type: "button", "aria-haspopup": "menu" },
  });
  const modeDescription = el("p", { class: "faint gatekeeper-mode-description" });
  const rulesButton = el("button", { class: "btn", text: "View rules" });
  rulesButton.addEventListener("click", () => openRulesModal(rulesButton));

  const purposeInput = el("textarea", {
    class: "text",
    attrs: { placeholder: PURPOSE_PLACEHOLDER, "aria-label": "Gatekeeper instructions" },
  });
  purposeInput.disabled = true;
  const saveText = el("span", { text: "" });
  const saveStatus = el("div", { class: "gatekeeper-save-status" }, [saveText]);
  const retrySave = el("button", { class: "cap-more", text: "Try again" });
  retrySave.hidden = true;
  saveStatus.appendChild(retrySave);
  const inactiveNote = el("p", {
    class: "faint gatekeeper-inactive-note",
    text: "These saved instructions will be used again when Gatekeeper is Enabled.",
  });
  inactiveNote.hidden = true;

  const node = el("section", { class: "audit-gatekeeper" }, [
    el("div", { class: "gatekeeper-head" }, [
      el("h2", { class: "gatekeeper-title", text: "Gatekeeper" }),
      modeButton,
      el("div", { class: "spacer" }),
      rulesButton,
    ]),
    modeDescription,
    el("div", { class: "gatekeeper-purpose" }, [
      el("div", { class: "gatekeeper-field-head" }, [
        el("label", { text: "Instructions" }),
        el("div", { class: "spacer" }),
        saveStatus,
      ]),
      purposeInput,
      inactiveNote,
    ]),
  ]);

  let inference = null;
  let autosave = null;
  let unsubscribe = null;
  let purposeListener = null;

  const drawMode = () => {
    const current = modeView(inference?.approvalMode);
    modeButton.replaceChildren(
      el("span", { text: current.label }),
      el("span", { class: "filter-caret", text: "▾" }),
    );
    modeButton.dataset.mode = current.mode;
    modeDescription.textContent = current.description;
    inactiveNote.hidden = current.mode === "adversarial";
  };

  const chooseMode = async (mode) => {
    modeButton.disabled = true;
    await window.domo.approvalModeSet(mode);
    inference = await window.domo.inferenceGet();
    modeButton.disabled = false;
    drawMode();
  };
  modeButton.addEventListener("click", () => {
    const current = modeView(inference?.approvalMode);
    openMenu(modeButton, GATEKEEPER_MODES.map((mode) => {
      const item = modeView(mode);
      return {
        label: item.label,
        description: item.description,
        checked: item.mode === current.mode,
        danger: item.mode === "approve",
        run: () => void chooseMode(item.mode),
      };
    }), { align: "left" });
  });

  const setSaveState = (state) => {
    saveStatus.className = `gatekeeper-save-status save-${state.phase}`;
    retrySave.hidden = state.phase !== "error";
    saveText.textContent = state.phase === "saving"
      ? "Saving…"
      : state.phase === "saved"
        ? "✓ Saved"
        : state.phase === "error"
          ? "Couldn't save."
          : "";
    if (state.phase === "saved" && purposeInput.value !== state.draft) {
      purposeInput.value = state.draft;
    }
  };

  const refreshMode = async () => {
    inference = await window.domo.inferenceGet();
    if (node.isConnected) drawMode();
  };
  const refreshRules = async () => {
    const rules = await window.domo.rulesList();
    if (node.isConnected) rulesButton.textContent = `View ${rules.length} ${rules.length === 1 ? "rule" : "rules"}`;
  };

  const ready = Promise.all([
    window.domo.inferenceGet(),
    window.domo.agentPurposeGet(),
    window.domo.rulesList(),
  ]).then(([nextInference, purpose, rules]) => {
    inference = nextInference;
    drawMode();
    rulesButton.textContent = `View ${rules.length} ${rules.length === 1 ? "rule" : "rules"}`;
    purposeInput.value = purpose;
    purposeInput.disabled = false;
    autosave = createSerialAutosave((value) => window.domo.agentPurposeSet(value), 500, purpose);
    unsubscribe = autosave.subscribe(setSaveState);
    purposeListener = () => autosave.edit(purposeInput.value);
    purposeInput.addEventListener("input", purposeListener);
    retrySave.addEventListener("click", () => autosave.retry());
  });

  return {
    node,
    ready,
    refreshMode,
    refreshRules,
    async flushPrompt() {
      await ready;
      const state = await autosave.flush();
      if (state.phase === "error") purposeInput.focus();
      return state.phase !== "error";
    },
    async savePurpose(value) {
      await ready;
      purposeInput.value = value;
      autosave.edit(value);
      return (await autosave.flush()).phase !== "error";
    },
    dispose() {
      unsubscribe?.();
      if (purposeListener) purposeInput.removeEventListener("input", purposeListener);
      autosave?.dispose();
    },
  };
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

/* A small menu under a "…" button: items as {label, run, disabled}. One open
   at a time; a click anywhere else, Escape, or picking an item closes it.
   Built like everything else here — nodes and textContent, no markup. */
let openMenuNode = null;
let openMenuAnchor = null;
function closeMenu() {
  if (!openMenuNode) return;
  openMenuNode.remove();
  openMenuNode = null;
  openMenuAnchor = null;
  document.removeEventListener("mousedown", onMenuOutside, true);
  document.removeEventListener("keydown", onMenuKey, true);
}
function onMenuOutside(e) { if (openMenuNode && !openMenuNode.contains(e.target)) closeMenu(); }
function onMenuKey(e) { if (e.key === "Escape") { e.preventDefault(); closeMenu(); } }
function openMenu(anchor, items, { align = "right" } = {}) {
  // The same button again closes what it opened.
  if (openMenuAnchor === anchor) { closeMenu(); return; }
  closeMenu();
  // A list where any item says whether it is checked is a pick-one list:
  // every item leaves room for the mark, and the current one shows it.
  const checkable = items.some((item) => item.checked !== undefined);
  const menu = el("div", { class: "menu", attrs: { role: "menu" } }, items.map((item) => {
    const b = el("button", {
      class: "menu-item" + (checkable ? " checkable" : "") +
        (item.checked ? " checked" : "") + (item.danger ? " danger" : ""),
      attrs: { type: "button", role: checkable ? "menuitemradio" : "menuitem", ...(checkable ? { "aria-checked": String(item.checked === true) } : {}) },
    }, [
      el("span", { class: "menu-label", text: item.label }),
      item.description ? el("span", { class: "menu-description", text: item.description }) : null,
    ]);
    b.disabled = item.disabled === true;
    b.addEventListener("click", () => { closeMenu(); item.run(); });
    return b;
  }));
  // Below the anchor, in viewport coordinates (the panel scrolls inside the
  // window, not the window itself). A "•••" at a row's right edge hangs
  // right-aligned; a filter button at the toolbar's left hangs from its left
  // edge, where the eye already is.
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  if (align === "left") menu.style.left = `${r.left}px`;
  else menu.style.right = `${document.documentElement.clientWidth - r.right}px`;
  document.body.appendChild(menu);
  openMenuNode = menu;
  openMenuAnchor = anchor;
  document.addEventListener("mousedown", onMenuOutside, true);
  document.addEventListener("keydown", onMenuKey, true);
  menu.querySelector("button:not(:disabled)")?.focus();
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
  for (const node of document.querySelectorAll(".titlebar, #view, .update-banner, .gatekeeper-notice")) {
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
  for (const node of document.querySelectorAll(".titlebar, #view, .update-banner, .gatekeeper-notice")) {
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
        if (createBtn.disabled) return;
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
          text: "For a tool that only needs MCP access to this Mac — a client that can't do OAuth. It reaches no chats and answers on no line.",
        }),
        el("div", { class: "field" }, [el("label", { text: "Name this connection" }), staticModal.nameInput]),
        el("p", {
          class: "faint conn-note",
          text: "The token is shown once. Revoke it from Other Agents and Clients on this pane.",
        }),
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
function connectNodes(s, redraw, openStatic = (trigger) => {
  staticOpen = true;
  openStaticModal(trigger, redraw);
  redraw();
}) {
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
      openStatic(link);
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

/** The OAuth-first MCP setup flow, kept off the inventory until requested. */
let mcpModal = null;

function closeMcpModal() {
  if (!mcpModal) return;
  closeModal(mcpModal);
  mcpModal = null;
}

function syncMcpModal(s, redraw) {
  if (!mcpModal) return;
  const cancel = el("button", { class: "btn", text: "Close" });
  cancel.addEventListener("click", closeMcpModal);
  const openStatic = () => {
    const trigger = mcpModal?.trigger;
    closeMcpModal();
    staticOpen = true;
    openStaticModal(trigger, redraw);
    redraw();
  };
  mcpModal.panel.replaceChildren(
    el("div", { class: "group-title", text: "Connect an MCP client" }),
    el("p", {
      class: "faint conn-note",
      text: "Add this server URL to Claude Code, Codex, Cursor, or any MCP-compatible client.",
    }),
    ...connectNodes(s, redraw, openStatic),
    el("div", { class: "row conn-actions" }, [el("div", { class: "spacer" }), cancel]),
  );
}

function openMcpModal(trigger, s, redraw) {
  const shell = openModal(trigger, {
    className: "connect-modal settings",
    onDismiss: closeMcpModal,
  });
  if (!shell) return;
  mcpModal = shell;
  syncMcpModal(s, redraw);
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
function openCloudModal(trigger, children, focus, onDismiss = closeCloudModal) {
  const shell = openModal(trigger, {
    children,
    className: "cloud-modal",
    focus,
    onDismiss: () => (cloudModal?.dismiss ?? onDismiss)(),
  });
  if (!shell) return null;
  cloudModal = shell;
  cloudModal.dismiss = onDismiss;
  return shell.panel;
}

function cloudStatus(status, failureReason) {
  if (status === "running") return { tone: "green", label: "Ready" };
  if (status === "provisioning") return { tone: "amber", label: "Setting up…" };
  if (status === "teardown") return { tone: "amber", label: "Removing…" };
  if (status === "failed") {
    return { tone: "red", label: `Failed · ${failureReason ?? "Reason unavailable"}` };
  }
  return { tone: "amber", label: "Status unavailable" };
}

function cloudLine(agent) {
  return agent?.line?.label || "No line";
}

function openCloudChangeLine(agent, state, redraw) {
  if (!cloudModal) return;
  const { panel } = cloudModal;
  cloudModal.kind = "change-line";
  const close = el("button", { class: "btn", text: "Cancel" });
  close.addEventListener("click", closeCloudModal);
  const note = el("p", { class: "faint", text: "Choose an existing line for this agent." });
  const choices = (state.cloudFreeLines ?? []).map((line) => {
    const button = el("button", { class: "btn", text: line.label });
    button.addEventListener("click", async () => {
      for (const choice of panel.querySelectorAll("button")) choice.disabled = true;
      const result = await window.domo.cloudChangeLine({ agentId: agent.agentId, lineUid: line.uid });
      if (result?.cloudActionError) {
        note.textContent = cloudErrorCopy(result.cloudActionError);
        for (const choice of panel.querySelectorAll("button")) choice.disabled = false;
      } else {
        closeCloudModal();
      }
      await redraw();
    });
    return button;
  });
  panel.replaceChildren(
    el("div", { class: "group-title", text: "Change line" }),
    note,
    ...choices,
    ...(!choices.length ? [el("p", { class: "faint", text: "No available lines." })] : []),
    close,
  );
}

function syncCloudModal(state, redraw) {
  if (!cloudModal) return;
  if (cloudModal.kind === "change-line" || cloudModal.kind === "deploy") return;
  const agent = (state.cloudAgents ?? [])
    .find((candidate) => candidate.agentId === cloudModal.agentId);
  if (!agent) {
    closeCloudModal();
    return;
  }
  const { panel } = cloudModal;
  const name = agent.name;

  const showDetail = () => {
    cloudModal.confirmingDelete = false;
    const close = el("button", { class: "btn", text: "Close" });
    const changeLine = agent.status === "failed"
      ? null
      : el("button", { class: "btn", text: "Change line" });
    const message = agent.canMessage ? el("button", { class: "btn", text: "Message" }) : null;
    const remove = el("button", { class: "btn danger", text: "Delete agent" });
    close.addEventListener("click", closeCloudModal);
    message?.addEventListener("click", () => window.domo.cloudOpenMessages(agent.agentId));
    changeLine?.addEventListener("click", () => openCloudChangeLine(agent, state, redraw));
    remove.addEventListener("click", () => {
      cloudModal.confirmingDelete = true;
      syncCloudModal(state, redraw);
    });
    const threads = agent.threads ?? [];
    panel.replaceChildren(
      el("div", { class: "group-title", text: name }),
      el("div", { class: "cloud-detail-meta" }, [
        el("div", { class: "cloud-detail-field" }, [
          el("span", { class: "faint", text: "Line" }),
          el("span", { text: cloudLine(agent) }),
        ]),
        el("div", { class: "cloud-detail-field" }, [
          el("span", { class: "faint", text: "Status" }),
          cloudStatusNode(agent),
        ]),
      ]),
      el("div", { class: "cloud-detail-threads" }, [
        el("div", { class: "cloud-detail-heading", text: "Threads" }),
        threads.length
          ? el("ul", { class: "cloud-thread-list" }, threads.map((thread) =>
              el("li", { text: thread.label || thread.uid })))
          : el("p", {
              class: "faint cloud-thread-empty",
              text: state.cloudChatsError
                ? "Threads couldn't be loaded."
                : !state.cloudChatsLoaded ? "Loading threads…"
                : agent.line ? "No threads on this line." : "No threads.",
            }),
      ]),
      el("div", { class: "row cloud-modal-actions" }, [
        close,
        el("div", { class: "spacer" }),
        message,
        changeLine,
        remove,
      ]),
    );
    close.focus();
  };

  const showConfirm = () => {
    const back = el("button", { class: "btn", text: "Cancel" });
    const confirm = el("button", { class: "btn danger", text: "Delete agent" });
    const note = el("p", { class: "faint modal-note", text: "" });
    back.addEventListener("click", () => {
      cloudModal.confirmingDelete = false;
      syncCloudModal(state, redraw);
    });
    confirm.addEventListener("click", async () => {
      back.disabled = true;
      confirm.disabled = true;
      note.textContent = "Deleting…";
      await window.domo.cloudRemove(agent.agentId);
      closeCloudModal();
      await redraw();
    });
    panel.replaceChildren(
      el("div", { class: "group-title", text: `Delete ${name}?` }),
      el("p", {
        class: "conn-note",
        text: "The agent will stop reading and replying, and your conversations on this line may be removed. To get another agent, use New agent to send a setup text.",
      }),
      note,
      el("div", { class: "row cloud-modal-actions" }, [
        back,
        el("div", { class: "spacer" }),
        confirm,
      ]),
    );
    back.focus();
  };

  if (cloudModal.confirmingDelete) showConfirm();
  else showDetail();
}

/** Show one agent's line, read-only threads, and lifecycle controls. */
function openCloudDetail(trigger, agent, state, redraw) {
  if (!openCloudModal(trigger, [], null)) return;
  Object.assign(cloudModal, { kind: "detail", agentId: agent.agentId, confirmingDelete: false });
  syncCloudModal(state, redraw);
}

function cloudErrorBanner(message, title = "Agents could not be refreshed") {
  if (!message) return null;
  return el("div", { class: "cloud-callout cloud-error" }, [
    el("div", { class: "cloud-callout-title", text: title }),
    el("p", { class: "faint", text: cloudErrorCopy(message) }),
  ]);
}

function cloudChatsErrorBanner(message, needsReactivation) {
  const reactivate = needsReactivation
    ? el("button", { class: "btn", text: "Sign out and re-activate" })
    : null;
  reactivate?.addEventListener("click", async () => {
    reactivate.disabled = true;
    await window.domo.relaySignOut();
  });
  return el("div", { class: "cloud-callout cloud-error" }, [
    el("div", { class: "cloud-callout-title", text: "Chats could not be loaded" }),
    el("p", { class: "faint", text: cloudErrorCopy(message) }),
    reactivate,
  ]);
}

function rosterName(row) {
  return row?.name?.trim() || "Unnamed MCP client";
}

function rosterDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "today";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function rosterAgo(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return rosterDate(value);
}

function rosterChatGrant(chatUids, chatAccess) {
  const chats = Array.isArray(chatUids) ? chatUids : [];
  if (chatAccess === "all") return "all chats";
  if (chatAccess === "none") return "no chats";
  if (!chats.length) return "no chats";
  if (chats.length === 1 && chats[0] === "*") return "all chats";
  return chats.length === 1 ? "1 chat" : `${chats.length} chats`;
}

function rosterPermissionCopy(row) {
  return [
    row.permissions.canReadAndReply
      ? `Reads and replies in ${rosterChatGrant(row.chatUids, row.chatAccess)}`
      : null,
    row.permissions.canSpendInference ? "Can spend inference" : null,
  ].filter(Boolean);
}

function entityMark(name, client = false) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const text = client
    ? words.slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "?"
    : (words[0]?.[0] || "?").toUpperCase();
  return el("span", { class: `entity-mark${client ? " client" : ""}`, text });
}

/** An agent's Agent Index logo — a PNG data URL main checked — or null to draw its initial. */
function logoMark(logo) {
  return logo ? el("span", { class: "entity-mark logo" }, [el("img", { attrs: { src: logo, alt: "" } })]) : null;
}

function closeRosterConfirm(shell) {
  if (shell) closeModal(shell);
}

function openRosterConfirm(row, trigger, redraw) {
  const cancel = el("button", { class: "btn", text: "Cancel" });
  const confirm = el("button", { class: "btn danger", text: "Revoke" });
  const note = el("p", { class: "faint modal-note", text: "" });
  let shell = null;
  const dismiss = () => closeRosterConfirm(shell);
  cancel.addEventListener("click", dismiss);
  confirm.addEventListener("click", async () => {
    cancel.disabled = true;
    confirm.disabled = true;
    note.textContent = "Revoking…";
    try {
      await window.domo.rosterRemove(row.id);
    } finally {
      dismiss();
      await redraw();
    }
  });
  shell = openModal(trigger, {
    className: "roster-confirm",
    focus: cancel,
    onDismiss: dismiss,
    children: [
      el("div", { class: "group-title", text: `Revoke ${rosterName(row)}?` }),
      el("p", { class: "conn-note", text: "Any client using this credential will stop working." }),
      note,
      el("div", { class: "row conn-actions" }, [cancel, el("div", { class: "spacer" }), confirm]),
    ],
  });
}

function rosterActions(row, redraw) {
  const name = rosterName(row);
  const more = el("button", {
    class: "btn more",
    text: "⋯",
    attrs: { "aria-label": `More actions for ${name}` },
  });
  const revoke = el("button", { class: "danger", text: "Revoke" });
  const menu = el("div", { class: "more-menu", attrs: { role: "menu" } }, [revoke]);
  menu.hidden = true;
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    for (const open of document.querySelectorAll(".more-menu:not([hidden])")) {
      if (open !== menu) open.hidden = true;
    }
    menu.hidden = !menu.hidden;
  });
  revoke.addEventListener("click", () => {
    menu.hidden = true;
    openRosterConfirm(row, more, redraw);
  });
  return [more, menu];
}

function cloudContext(agent, state) {
  const created = rosterDate(agent?.createdAt);
  return [
    agentKind(agent.provider, state.cloudProviders ?? []),
    cloudLine(agent),
    created ? `Created ${created}` : null,
  ].filter(Boolean).join(" · ");
}

function cloudStatusNode(agent) {
  if (agent?.status === null) return badge(agent.connected ? "green" : "faint", agent.connected ? "Connected" : "Offline");
  const status = cloudStatus(agent?.status, agent?.failureReason);
  if (agent?.status === "provisioning") {
    return el("span", { class: "status-setting" }, [
      el("span", { class: "cloud-spinner", attrs: { "aria-hidden": "true" } }),
      el("span", { text: status.label }),
    ]);
  }
  if (agent?.status === "teardown") {
    return el("span", { class: "status-setting status-removing", text: status.label });
  }
  return badge(status.tone, status.label);
}

function cloudEntityRow(agent, state, redraw) {
  const name = agent.name;
  const main = el("div", {
    class: "entity-main cloud-agent-open",
    attrs: { role: "button", tabindex: "0", "aria-label": `View ${name}` },
  }, [
    el("div", { class: "entity-top" }, [
      el("span", { class: "entity-name", text: name }),
      cloudStatusNode(agent),
    ]),
    el("div", {
      class: "entity-context",
      text: cloudContext(agent, state),
      attrs: { title: cloudContext(agent, state) },
    }),
  ]);
  main.addEventListener("click", () => openCloudDetail(main, agent, state, redraw));
  main.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openCloudDetail(main, agent, state, redraw);
  });
  const message = agent.canMessage
    ? el("button", {
        class: "btn small message-btn",
        text: "Message",
        attrs: { "aria-label": `Message ${name}` },
      })
    : null;
  message?.addEventListener("click", () => window.domo.cloudOpenMessages(agent.agentId));
  const actions = [message].filter(Boolean);
  const row = el("div", { class: "entity-row cloud-agent-row", attrs: { "data-cloud-agent-id": agent.agentId } }, [
    logoMark(state.cloudAgentIndex?.[agent.provider]?.logo) ?? entityMark(name),
    main,
    actions.length ? el("div", { class: "entity-actions" }, actions) : null,
  ]);
  const age = agent.agentId === justDeployed?.id ? performance.now() - justDeployed.at : Infinity;
  if (age < NEW_AGENT_HIGHLIGHT_MS) {
    row.classList.add("cloud-agent-new");
    // CSSOM, which style-src 'self' allows: a redraw continues the fade, not restarts it.
    row.style.animationDelay = `-${age}ms`;
  }
  return row;
}

function clientEntityRow(row, redraw) {
  const name = rosterName(row);
  const context = [
    "MCP client",
    // Which Mac this credential works from. The main process hands down a
    // label and never the device uid, and it goes in as text — a device name
    // is a string somebody else chose.
    row.deviceLabel ? `Bound to ${row.deviceLabel}` : "Works from any Mac",
    row.createdAt ? `Created ${rosterDate(row.createdAt) ?? "date unknown"}` : "Created date unknown",
    row.lastSeenAt ? `Last used ${rosterAgo(row.lastSeenAt) ?? "date unknown"}` : "Never used",
  ].filter(Boolean).join(" · ");
  return el("div", { class: "entity-row" }, [
    entityMark(name, true),
    el("div", { class: "entity-main" }, [
      el("div", { class: "entity-top" }, [
        el("span", { class: "entity-name", text: name }),
      ]),
      el("div", { class: "entity-context", text: context }),
      el("div", { class: "entity-perms" }, rosterPermissionCopy(row).map((text) =>
        el("span", { text }),
      )),
    ]),
    el("div", { class: "entity-actions" }, rosterActions(row, redraw)),
  ]);
}

function sectionHeader(title, count, unit, action) {
  return el("div", { class: "list-section-head" }, [
    el("h2", { text: title }),
    el("span", { class: "faint", text: `${count} ${unit}${count === 1 ? "" : "s"}` }),
    el("div", { class: "spacer" }),
    action,
  ]);
}

/** The agent the deploy modal just saw arrive, and when. Expires by time, not
    by first draw: one arrival publishes twice, and both draws must highlight. */
let justDeployed = null;
const NEW_AGENT_HIGHLIGHT_MS = 2500; // .cloud-agent-new's animation in styles.css

/** The deploy picker: a card per agent Plow offers, described by the Agent Index. */
function openDeployModal(trigger, s, redraw) {
  const cards = deployCards(s.cloudProviders ?? [], s.cloudAgentIndex ?? {});
  const deploy = el("button", { class: "btn primary", text: "Deploy" });
  deploy.disabled = true;
  const cancel = el("button", { class: "btn", text: "Cancel" });
  cancel.addEventListener("click", closeCloudModal);
  const grid = el("div", { class: "deploy-grid" }, cards.map((card) => {
    const button = el("button", { class: "deploy-card", attrs: { type: "button", "aria-pressed": "false" } }, [
      el("span", { class: "deploy-card-top" }, [
        logoMark(card.logo) ?? el("span", { class: "entity-mark", text: card.initial }),
        el("span", { class: "deploy-card-name", text: card.name }),
      ]),
      card.blurb ? el("span", { class: "deploy-card-blurb", text: card.blurb }) : null,
      el("span", { class: "deploy-card-byline", text: card.byline }),
    ]);
    button.addEventListener("click", () => {
      for (const other of grid.children) {
        other.classList.remove("selected");
        other.setAttribute("aria-pressed", "false");
      }
      button.classList.add("selected");
      button.setAttribute("aria-pressed", "true");
      cloudModal.selected = card;
      deploy.disabled = false;
      deploy.textContent = `Deploy ${card.name}`;
    });
    return button;
  }));
  const panel = openCloudModal(trigger, [
    el("div", { class: "deploy-head" }, [
      el("div", { class: "group-title", text: "Deploy an agent" }),
      el("span", { class: "faint", text: `${cards.length} agent${cards.length === 1 ? "" : "s"}` }),
    ]),
    grid,
    el("div", { class: "deploy-foot" }, [
      el("span", { class: "faint deploy-note", text: "Opens Messages with a setup text to Plow." }),
      cancel,
      deploy,
    ]),
  ], grid.firstElementChild);
  if (!panel) return;
  panel.classList.add("deploy-modal");
  Object.assign(cloudModal, { kind: "deploy", selected: null, deployToken: null });
  deploy.addEventListener("click", () => void deployAgent(panel, cloudModal.selected, redraw));
}

/** Open Messages with the card's setup text, then wait for the agent it makes.
    The token is swapped only once Messages opened, so a failed retry keeps the
    running wait; a stale answer (closed modal, a later retry) is ignored. */
async function deployAgent(panel, card, redraw) {
  const modal = cloudModal;
  for (const button of panel.querySelectorAll("button")) button.disabled = true;
  const opened = await window.domo.cloudNewAgentMessages(card.id).catch(() => false);
  if (cloudModal !== modal) return;
  if (!opened) {
    // Main had no setup text to send: a failed refresh dropped Plow's catalog
    // (its API mid-deploy, say). An sms: link itself always opens on macOS.
    const note = panel.querySelector(".deploy-note");
    note.textContent = "Plow isn't answering right now. Try again in a minute.";
    note.classList.add("error");
    for (const button of panel.querySelectorAll("button")) button.disabled = false;
    return;
  }
  const token = {};
  modal.deployToken = token;
  showDeployWaiting(panel, card, false, redraw);
  const agentId = await window.domo.cloudAwaitNewAgent(card.id);
  if (cloudModal?.deployToken !== token) return;
  if (!agentId) {
    showDeployWaiting(panel, card, true, redraw);
    return;
  }
  justDeployed = { id: agentId, at: performance.now() };
  closeCloudModal();
  await redraw();
}

function showDeployWaiting(panel, card, timedOut, redraw) {
  const again = el("button", { class: "btn", text: "Open Messages again" });
  again.addEventListener("click", () => void deployAgent(panel, card, redraw));
  const close = el("button", { class: "btn", text: "Close" });
  close.addEventListener("click", closeCloudModal);
  panel.replaceChildren(
    el("div", { class: "deploy-head" }, [el("div", { class: "group-title", text: `Deploying ${card.name}` })]),
    el("div", { class: "deploy-wait" }, [
      timedOut ? null : el("span", { class: "cloud-spinner", attrs: { "aria-hidden": "true" } }),
      el("div", {
        class: "deploy-wait-title",
        text: timedOut ? `We haven't seen ${card.name} yet` : "Send the text in Messages",
      }),
      el("p", {
        class: "faint",
        text: timedOut
          ? "If you didn't send the text, open Messages again."
          : `Messages opened with your setup text to Plow. Send it, and ${card.name} will appear on this tab in about a minute. This closes on its own when it does.`,
      }),
    ]),
    el("div", { class: "deploy-foot" }, [el("span", { class: "faint deploy-note" }), again, close]),
  );
}

function cloudSection(s, redraw) {
  const add = el("button", { class: "btn primary", text: "New agent" });
  const providerView = cloudProviderPickerViewModel(s.cloudProviders, s.cloudProvidersError);
  add.disabled = !(s.cloudProviders?.length);
  add.addEventListener("click", () => openDeployModal(add, s, redraw));
  const rows = s.cloudAgents.map((agent) => cloudEntityRow(agent, s, redraw));
  const notices = [];
  if (!s.cloudChatsLoaded) {
    notices.push(s.cloudChatsError
      ? cloudChatsErrorBanner(
          s.cloudChatsError,
          s.cloudChatsNeedReactivation === true,
        )
      : el("div", { class: "cloud-progress cloud-loading" }, [
          el("span", { class: "cloud-spinner", attrs: { "aria-hidden": "true" } }),
          el("span", { text: "Loading chats…" }),
        ]));
  }
  const refreshError = cloudErrorBanner(s.cloudAgentsError);
  if (refreshError) notices.push(refreshError);
  if (s.cloudActionError) notices.push(cloudErrorBanner(s.cloudActionError, "That change did not finish"));
  return el("section", { class: "list-section" }, [
    sectionHeader("Plow Agents", rows.length, "agent", add),
    ...(providerView.mode === "blocked" ? [cloudErrorBanner(providerView.message, providerView.heading)] : []),
    ...notices,
    el("div", { class: "entity-list compact-list" }, rows.length
      ? rows
      : [el("div", { class: "empty entity-empty", text: "No agents." })]),
  ]);
}

function clientSection(s, redraw) {
  const add = el("button", { class: "btn small", text: "Connect MCP client" });
  add.addEventListener("click", () => openMcpModal(add, s, redraw));
  const rows = s.roster.map((row) => clientEntityRow(row, redraw));
  return el("section", { class: "list-section" }, [
    sectionHeader("Other Agents and Clients", rows.length, "client", add),
    el("div", { class: "entity-list compact-list" }, rows.length
      ? rows
      : [el("div", { class: "empty entity-empty", text: "No other agents or clients." })]),
  ]);
}

function rosterNotice(s) {
  if (!s.rosterError && !s.actionError) return null;
  return el("div", { class: "roster-notices" }, [
    s.rosterError ? cloudErrorBanner(s.rosterError, "Clients could not be refreshed") : null,
    s.actionError ? cloudErrorBanner(s.actionError, "Plow could not confirm that change") : null,
  ]);
}

/** The mounted Agents pane; its one refresh redraws all three views of state. */
let agentsMounted = null;

async function renderAgents() {
  const panel = el("div", { class: "panel agents agents-roster" });
  view.replaceChildren(panel);
  const refreshConnect = async () => {
    const s = await window.domo.connectGet();
    if (!s || !panel.isConnected) return s;
    panel.replaceChildren(...[
      rosterNotice(s),
      cloudSection(s, refreshConnect),
      clientSection(s, refreshConnect),
    ].filter(Boolean));
    syncCloudModal(s, refreshConnect);
    syncMcpModal(s, refreshConnect);
    if (s.credential && !staticModal) openStaticModal(null, refreshConnect);
    syncStaticModal(s, refreshConnect);
    return s;
  };
  agentsMounted = { refreshConnect };
  await refreshConnect();
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
    case "apple_events": return c.allowed ? "apple events: may control this Mac's apps" : "apple events: denied";
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

// ---- Plugins, and the permission inventory Settings holds ----
// Two panes, one shape each, both from IPC: the Plugins tab draws
// `pluginsModel.ts`'s rows (what each plugin still needs), and Settings'
// Permissions section draws `capabilitiesModel.ts`'s
// sections, banner and rows. The renderer keeps nothing of its own but which
// rows are open.

let pluginsMounted = null;
let permissionsMounted = null;

/** The audit tab, filtered to what this Mac blocked: the Blocked chip, and
    the search box set to `term` — a switch's name from a row's button, or
    cleared from the banner's, so a stale search never hides the rows. */
// The Permissions section's "Show in Audit": the blocked rows, narrowed to one
// switch by `term` when a row asked, and to the moment the count started
// from by `since` — so the list is exactly the requests it counted.
async function showAuditBlocked(term = "", since = null) {
  decisionFilter = "any";
  statusFilter = "blocked";
  dateSince = since;
  dateFilter = since ? "since" : "any";
  auditSearch = term;
  if (await selectTab("audit")) window.domo.uiSetTab("audit");
}

/** How long ago, in words: "just now", "4 minutes ago", "3 hours ago",
    "yesterday", "5 days ago". Coarse on purpose — it says whether an agent
    is stuck right now or gave up last night, nothing finer. */
function agoText(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? "an hour ago" : `${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function whenText(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Settings' Permissions section: every switch this Mac has — the
 * machine-configuration view, where the Plugins tab shows only what is unmet.
 * Returns the drawn container and how to refresh it; `display: contents`
 * keeps its cards in Settings' own column.
 */
function permissionsPane() {
  // The inventory is a probe sweep — seconds on a Mac where a target app is
  // not answering Apple events — so the node is handed back at once with this
  // line in it, and the rows replace it when the read lands.
  const panel = el("div", { class: "permissions" }, [
    el("p", { class: "faint", text: "Checking this Mac's permissions…" }),
  ]);
  const openRows = new Set();
  // Which groups are open. Seeded from the model on first sight of each
  // group (a group with blocked requests inside opens itself), then the
  // owner's clicks own it for the life of this mount.
  const openGroups = new Map();
  /** Per group, the newest block the last draw showed — so a newer one can open it. */
  const groupNewest = new Map();
  // macOS's own icons per row key, from main; kept across redraws (an act
  // answers with the view alone) and refreshed on a full read.
  let icons = {};
  const iconCell = (key) => {
    const src = icons[key];
    return src
      ? el("img", { class: "cap-icon", attrs: { src, alt: "" } })
      : el("span", { class: "cap-icon" });
  };

    // The same connector state and card used by setup, mounted into a stable
  // box so a poll or account action redraws only this section. `loading` is a
  // renderer-only placeholder; main's state deliberately contains display
  // data only and does not need to know whether this pane has painted yet.
  let connectorState = {
    busy: true,
    message: "",
    noteKind: "error",
    loading: true,
    google: { accounts: [], connecting: false },
  };
  const connectorBox = el("div", { class: "settings-connectors" });
  const connectorNote = el("p", {
    class: "connector-note",
    attrs: { role: "status" },
  });
  const connectorMutate = singleFlight(() => connectorState.busy === true);
  const connectorActions = {
    connect: () => connectorMutate(async () => {
      applyConnectors(await window.domo.connectorsConnect());
    }),
    disconnect: (account) => connectorMutate(async () => {
      applyConnectors(await window.domo.connectorsDisconnect(account));
    }),
    setDefault: (account) => connectorMutate(async () => {
      applyConnectors(await window.domo.connectorsSetDefault(account));
    }),
  };
  const drawConnectors = () => {
    connectorBox.replaceChildren(connectorRow(connectorState, connectorActions));
    connectorNote.textContent = connectorState.message;
    connectorNote.hidden = !connectorState.message;
    connectorNote.className = `connector-note ${connectorState.noteKind}`;
  };
  const applyConnectors = (next) => {
    if (!next) return;
    connectorState = { ...next, loading: false };
    drawConnectors();
  };
  const refreshConnectors = async () => {
    applyConnectors(await window.domo.connectorsRefresh());
  };
  drawConnectors();
  void refreshConnectors();

  const draw = (v) => {
    const nodes = [];
    if (v.banner) {
      const summary = v.banner.summary.map((s) => `${s.count} ${s.title}`).join(", ");
      const one = v.banner.count === 1;
      const oneSwitch = v.banner.switches === 1;
      // Two actions, both buttons: dismissing resets the whole tab (not just
      // this strip), which is more than an × should carry.
      const showInAudit = el("button", { class: "btn small", text: "Show in Audit", attrs: { type: "button" } });
      showInAudit.addEventListener("click", () => showAuditBlocked("", v.banner.since));
      const close = el("button", { class: "btn small", text: "Dismiss", attrs: { type: "button" } });
      close.addEventListener("click", async () => draw(await window.domo.capabilitiesBannerSeen()));
      nodes.push(el("div", { class: "cap-banner" }, [
        icon("warning", { class: "ico cap-banner-icon" }),
        el("div", {}, [
          // Leads with how many switches need attention, then what they did.
          el("div", { class: "bt", text:
            `${v.banner.switches} capabilit${oneSwitch ? "y needs" : "ies need"} to be allowed. ` +
            `${oneSwitch ? "It" : "They"} blocked ${v.banner.count} request${one ? "" : "s"}, ` +
            `${one ? "" : "the latest "}${agoText(v.banner.last)}.` }),
          el("div", { class: "bs", text: `${summary}.` }),
        ]),
        el("div", { class: "spacer" }),
        showInAudit,
        close,
      ]));
    }
    for (const section of v.sections) {
      nodes.push(group(section.title, section.description, section.items.map((item) =>
        item.kind === "group" ? capabilityGroup(item) : capabilityRow(item),
      )));
    }
    nodes.push(group("Connected Accounts", null, [connectorBox, connectorNote]));
    panel.replaceChildren(...nodes);
  };

  const act = async (key, button) => {
    button.disabled = true;
    const was = button.textContent;
    // The act waits for its flow to end — the panel, a dialog, the owner in
    // System Settings — so the button waits with it.
    button.textContent = "Waiting…";
    try {
      draw(await window.domo.capabilitiesAct(key));
    } catch {
      button.disabled = false;
      button.textContent = was;
    }
  };

  const capabilityRow = (r) => {
    // Three dots: green works; red will NOT work as things stand, whether
    // macOS refused it or has simply never been asked — an agent's request
    // fails either way until the owner acts; grey when this Mac cannot tell
    // (an app that is not open, no helper). The tooltip keeps the words.
    const dotClass =
      r.status === "granted" ? " on"
      : r.needsAttention || r.status === "denied" || r.status === "not_asked" ? " off"
      : "";
    let action;
    // A word, not a button: nothing to press once it is granted.
    if (r.status === "granted") action = el("span", { class: "cap-granted", text: "Granted" });
    else if (r.actionLabel) {
      // Plain, whatever the row's state: the amber dot and the request line
      // already say which rows need a decision, and a blue button would read
      // as "the one thing to do here" when every row is the owner's call.
      action = el("button", { class: "btn", text: r.actionLabel });
      action.addEventListener("click", () => act(r.key, action));
    } else action = el("span");
    // What the switch stopped, as a third line under the name — the count,
    // when, who, and the link to the requests themselves (an explicit link:
    // a row that merely opened on click never read as something to click).
    // Nothing at all for a row nothing has hit — or for one that is granted
    // now: what it stopped before the grant is history, and the Audit tab's.
    let asks = null;
    if (r.count > 0 && r.status !== "granted") {
      const more = el("button", { class: "cap-more", text: openRows.has(r.key) ? "Hide blocked requests" : "See blocked requests…" });
      more.addEventListener("click", async () => {
        if (openRows.has(r.key)) openRows.delete(r.key); else openRows.add(r.key);
        draw(await window.domo.capabilitiesGet().then((c) => c.view));
      });
      asks = el("div", { class: "cap-sub cap-asks" }, [
        el("span", { class: "cap-count", text: `${r.count} request${r.count === 1 ? "" : "s"}` }),
        el("span", { text: ` · last ${whenText(r.last)}${r.agents.length ? ` · ${r.agents.join(", ")}` : ""} · ` }),
        more,
      ]);
    }
    // A row showing blocked requests points at its button: the grant panel's
    // filled arrow, turned to the right, nudging toward it (CSS animates it;
    // reduced-motion holds it still). Only while there is something to do.
    const pointed = asks && r.actionLabel
      ? el("span", { class: "cap-action" }, [icon("nudgeArrow", { class: "cap-nudge", fill: true }), action])
      : action;
    if (asks && r.actionLabel) action.classList.add("attention");
    const children = [
      el("span", { class: "status-dot" + dotClass, attrs: { title: r.statusText } }),
      iconCell(r.key),
      el("div", {}, [
        el("div", { class: "cap-name", text: r.title }),
        r.detail ? el("div", { class: "cap-sub", text: r.detail }) : null,
        asks,
      ]),
      pointed,
    ];
    if (r.count > 0 && r.status !== "granted" && openRows.has(r.key)) children.push(expanded(r));
    return el("div", { class: "cap-row" }, children);
  };

  /* The Google connector in a switch row's clothes, so Connected Accounts
     reads like This Mac: the brand mark where a row keeps its icon, the
     bold name and a line under it, and an external-link button on the
     right — connecting opens Google's consent page in the browser.
     Connected accounts list under the row. */
  /* Google's four-colour G, as on their own app icon: a white rounded tile
     with the standard sign-in mark. Built with createElementNS like every
     glyph in dom.js — nothing here goes through innerHTML. */
  function googleMark() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 48 48");
    svg.setAttribute("class", "cap-google-g");
    svg.setAttribute("aria-hidden", "true");
    const paths = [
      ["#EA4335", "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"],
      ["#4285F4", "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"],
      ["#FBBC05", "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"],
      ["#34A853", "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"],
    ];
    for (const [fill, d] of paths) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("fill", fill);
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return el("span", { class: "cap-icon cap-brand" }, [svg]);
  }

  // A declaration, not a const: the connectors block above draws itself the
  // moment it is set up, before this line would run.
  function connectorRow(state, actions) {
    const google = state.google;
    const busy = state.busy === true;
    const connecting = google.connecting === true;
    const button = el("button", { class: "btn", attrs: { type: "button" } }, [
      el("span", { text: connecting ? "Connecting…" : state.loading ? "Checking…" : google.accounts.length ? "Add another" : "Connect" }),
      connecting || state.loading ? null : extArrow(),
    ]);
    button.disabled = busy || connecting || state.loading;
    if (!button.disabled) button.addEventListener("click", actions.connect);
    // Each account as a row of its own under the Google row, its person
    // glyph in the icon column and its address lined up with "Google", the
    // default's green pill beside the address, and a "…" menu on the right
    // holding the two things that can be done to it.
    const accounts = google.accounts.map((account) => {
      const menuButton = el("button", { class: "btn cap-account-menu-btn", attrs: { type: "button", "aria-label": "Account actions", "aria-haspopup": "menu" } }, [
        el("span", { text: "•••" }),
      ]);
      menuButton.disabled = busy;
      menuButton.addEventListener("click", (e) => {
        e.stopPropagation();
        openMenu(menuButton, [
          { label: "Set as Default", disabled: account.isDefault, run: () => actions.setDefault(account.email) },
          { label: "Remove Account", run: () => actions.disconnect(account.email) },
        ]);
      });
      return el("div", { class: "cap-row cap-account-row" }, [
        el("span", { class: "cap-icon cap-person" }, [icon("user", { strokeWidth: "2" })]),
        el("div", { class: "cap-account-line" }, [
          // Server data is assigned through textContent by el().
          el("span", { class: "cap-name cap-account-email", text: account.email }),
          account.isDefault ? el("span", { class: "badge b-zinc cap-default-pill", text: "Default" }) : null,
        ]),
        menuButton,
      ]);
    });
    const head = el("div", { class: "cap-row" }, [
      el("span", { class: "status-dot" + (google.accounts.length ? " on" : "") }),
      googleMark(),
      el("div", {}, [
        el("div", { class: "cap-name", text: "Google" }),
        el("div", { class: "cap-sub", text: "Gmail, Calendar, and Drive, through accounts you connect." }),
      ]),
      button,
    ]);
    return el("div", { class: "cap-group open" }, [
      head,
      accounts.length ? el("div", { class: "cap-account-rows" }, accounts) : null,
    ]);
  }

  /* A disclosure of several switches of one kind: a chevron, the name,
     "N of M granted" on the right, and the rows beneath when open. */
  const capabilityGroup = (g) => {
    if (!openGroups.has(g.key)) openGroups.set(g.key, g.expandedByDefault);
    // A block that lands inside a closed group while the tab is open would
    // otherwise be counted and hidden: the group opens itself when a switch
    // in it is hit by something newer than the last draw saw. The first
    // draw only takes note — opening on mount is expandedByDefault's job —
    // and a group the owner closed afterwards stays closed until the next
    // new block, not forever.
    const newest = g.rows.reduce((t, r) => (r.count > 0 && r.last !== null && r.last > t ? r.last : t), "");
    const seen = groupNewest.get(g.key);
    if (seen !== undefined && newest > seen) openGroups.set(g.key, true);
    groupNewest.set(g.key, newest);
    const open = openGroups.get(g.key);
    // The row grid's own shape — the chevron where a row keeps its dot, the
    // name and line where a row keeps its own, the count where a row keeps
    // its button — so a group line is exactly as tall as a switch's.
    const head = el("button", { class: "cap-row cap-group-head", attrs: { type: "button", "aria-expanded": String(open) } }, [
      el("span", { class: "cap-chevron-cell" }, [icon("chevron", { class: "ico cap-chevron" + (open ? " open" : "") })]),
      iconCell(`group:${g.key}`),
      el("div", {}, [
        el("div", { class: "cap-name", text: g.title }),
        el("div", { class: "cap-sub", text: g.description }),
      ]),
      el("span", { class: "cap-group-count", text: `${g.granted} of ${g.total} granted` }),
    ]);
    head.addEventListener("click", async () => {
      openGroups.set(g.key, !open);
      draw(await window.domo.capabilitiesGet().then((c) => c.view));
    });
    return el("div", { class: "cap-group" + (open ? " open" : "") }, [
      head,
      open ? el("div", { class: "cap-group-rows" }, g.rows.map((r) => capabilityRow(r))) : null,
    ]);
  };

  const expanded = (r) => {
    const reqs = r.requests.map((q) => el("div", { class: "cap-req" }, [
      el("span", { class: "t", text: whenText(q.at) }),
      el("span", {}, [
        el("span", { class: "who", text: q.agent ?? "an agent" }),
        el("span", { class: "goal", text: q.goal ? ` — ${q.goal}` : q.request ? ` — ${q.request}` : "" }),
      ]),
    ]));
    const sentence = r.requests.find((q) => q.ownerAction)?.ownerAction ?? null;
    // The banner's pair, for this one switch: Dismiss clears these requests
    // from the tab (the Audit tab keeps them) until a newer block lands.
    const inAudit = el("button", { class: "btn small", text: "Show in Audit", attrs: { type: "button" } });
    inAudit.addEventListener("click", () => showAuditBlocked(r.title, r.since));
    const notNow = el("button", { class: "btn small", text: "Dismiss", attrs: { type: "button" } });
    notNow.addEventListener("click", async () => draw(await window.domo.capabilitiesDismiss(r.key)));
    return el("div", { class: "cap-expand" }, [
      el("p", { class: "lbl", text: "Blocked requests" }),
      ...reqs,
      ...(sentence
        ? [el("div", { class: "cap-sentence" }, [el("p", { class: "lbl", text: "What the agent was told" }), el("span", { text: sentence })])]
        : []),
      el("div", { class: "cap-actions" }, [
        ...(r.hint ? [el("span", { class: "badge b-amber" }, [el("span", { class: "dot" }), el("span", { text: r.hint })])] : []),
        el("div", { class: "spacer" }),
        inAudit,
        notNow,
      ]),
    ]);
  };

  const load = async () => {
    const c = await window.domo.capabilitiesGet();
    icons = c.icons ?? icons;
    draw(c.view);
  };
  void load();
  return {
    node: panel,
    mounted: {
      applyConnectors,
      refresh: async () => {
        await load();
        await refreshConnectors();
      },
    },
  };
}

/**
 * The Plugins tab: one row per staged plugin — whether it can work right now
 * and the one thing the owner has to do if it cannot. A met requirement
 * renders NOTHING; the inventory is Settings' Permissions section. Every
 * plugin-authored string (name, description) goes through `el`, which sets
 * textContent — never innerHTML, as in the approval window.
 */
async function renderPlugins() {
  const panel = el("div", { class: "panel settings" });
  view.replaceChildren(panel);
  // The three statuses, in the row's own vocabulary: the dot's class and the
  // word beside the toggle. Amber for needs-setup — it is the owner's to fix.
  const STATUS = {
    off: { dot: "", tone: "zinc", word: "Off" },
    "needs-setup": { dot: " off", tone: "amber", word: "Needs setup" },
    ready: { dot: " on", tone: "green", word: "Ready" },
  };
  const reload = async () => draw(await window.domo.pluginsGet());

  // A row with no action (e.g. the Browser row's missing runtime) shows
  // just the sub text; one with an action gets a button that runs that
  // requirement by id, whatever kind it is, and waits for its flow to end.
  // The answer is the fresh tab, with the act's error line when it has one.
  // A grant waiting on a relaunch has nothing left to act on: its button
  // relaunches the app.
  const unmetRow = (u) => {
    const action = u.action
      ? el("button", { class: "btn attention", text: u.action, attrs: { type: "button" } })
      : null;
    action?.addEventListener("click", async () => {
      action.disabled = true;
      if (u.status === "relaunch") return window.domo.appRelaunch();
      action.textContent = "Waiting…";
      try {
        draw(await window.domo.requirementsAct(u.id));
      } catch {
        action.disabled = false;
        action.textContent = u.action;
      }
    });
    return el("div", { class: "cap-row plugin-req" }, [
      el("span", { class: "status-dot off" }),
      el("div", {}, [
        el("div", { class: "cap-name", text: u.title }),
        el("div", { class: "cap-sub", text: u.detail }),
      ]),
      action,
    ]);
  };

  const pluginRow = (r) => {
    const s = STATUS[r.status];
    const box = el("input", { attrs: { type: "checkbox", "aria-label": `Turn ${r.title} on or off` } });
    box.checked = r.status !== "off";
    box.addEventListener("change", async () => {
      box.disabled = true;
      try {
        draw(await window.domo.pluginsSetEnabled(r.name, box.checked));
      } catch {
        box.checked = !box.checked;
        box.disabled = false;
      }
    });
    const head = el("div", { class: "cap-row plugin-row" }, [
      el("span", { class: "status-dot" + s.dot, attrs: { title: s.word } }),
      el("div", {}, [
        el("div", { class: "cap-name plugin-name" }, [
          el("span", { text: r.title }),
          badge("zinc", r.kind),
        ]),
        r.description ? el("div", { class: "cap-sub", text: r.description }) : null,
      ]),
      badge(s.tone, s.word),
      switchEl(box, { title: "Turn this plugin on or off" }),
    ]);
    // Every requirement, met or not, is on the row now — off hides them all
    // (the owner's problem again only once they turn the plugin back on);
    // otherwise only the ones still outstanding show.
    const unmet = r.status !== "off" ? r.requirements.filter((q) => q.status !== "met") : [];
    return el("div", { class: "cap-group open" }, [
      head,
      unmet.length ? el("div", { class: "cap-group-rows" }, unmet.map(unmetRow)) : null,
    ]);
  };

  const draw = (state) => {
    const rows = state.rows.map(pluginRow);
    panel.replaceChildren(group(
      "Plugins",
      "The tools agents can run on this Mac. Turning one off unpublishes its skill and refuses its commands.",
      state.error ? [el("p", { class: "warn", text: state.error }), ...rows] : rows,
    ));
  };

  draw(await window.domo.pluginsGet());
  pluginsMounted = { refresh: reload };
  // Main holds no accounts until something asks Plow, so a launch straight into
  // this tab said "Needs setup" for a connected Google. Not awaited — selecting
  // a tab never waits on the network; onConnectorsChanged redraws this tab.
  void window.domo.connectorsRefresh();
}

async function renderSettings() {
  const generation = ++settingsRenderGeneration;
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

  // Keep Mac Awake. The blocker is held only while plugged in — on battery
  // the Mac sleeps normally — and set answers with what actually took: an
  // acquire the OS refuses comes back off, and the box shows that rather
  // than a hold that isn't held.
  let awake = await window.domo.keepAwakeGet();
  const awakeBox = el("input", { attrs: { type: "checkbox" } });
  const awakeLabel = el("label", { class: "check" }, [
    awakeBox,
    el("span", { text: "Keep this Mac awake while plugged in" }),
  ]);
  const applyAwake = () => { awakeBox.checked = awake.enabled; };
  awakeBox.addEventListener("change", async () => {
    try {
      awake = await window.domo.keepAwakeSet(awakeBox.checked);
    } catch {
      // The write failed, so nothing changed — put the box back on the last
      // state main acknowledged rather than leaving the click's optimism.
    }
    applyAwake();
  });
  applyAwake();

  // Usage statistics + error reports. Allowlisted (telemetry.ts), linked to
  // the signed-in account, and honored on the very next event — no relaunch.
  // Not called "anonymous": events key on the account uid, and the label
  // must not promise more privacy than the wire delivers.
  let stats = await window.domo.telemetryGet();
  const statsBox = el("input", { attrs: { type: "checkbox" } });
  const statsLabel = el("label", { class: "check" }, [
    statsBox,
    el("span", { text: "Share usage statistics and error reports" }),
  ]);
  const applyStats = () => { statsBox.checked = stats.enabled; };
  statsBox.addEventListener("change", async () => {
    try {
      stats = await window.domo.telemetrySet(statsBox.checked);
    } catch {
      // The write failed, so nothing changed — show the last acknowledged state.
    }
    applyStats();
  });
  applyStats();

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

  // The permission inventory and the connected accounts, which used to be a
  // tab of their own: the machine-configuration view, where it belongs. Not
  // awaited — selecting a tab never waits on a probe sweep (#446); the rows
  // fill in when the read lands.
  const permissions = permissionsPane();
  if (generation !== settingsRenderGeneration || currentTab !== "settings") return;
  permissionsMounted = permissions.mounted;

  const mounted = {
    refresh: async () => {
      await refreshAccount();
      launch = await window.domo.launchGet();
      applyLaunch();
      awake = await window.domo.keepAwakeGet();
      applyAwake();
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
  if (generation !== settingsRenderGeneration || currentTab !== "settings") return;
  settingsMounted = mounted;
  await mounted.refreshUpdates();

  if (generation !== settingsRenderGeneration || currentTab !== "settings") return;
  view.replaceChildren(el("div", { class: "panel settings" }, [
    // The old subtitle promised a phone number this screen never shows. The
    // activation flow learns it server-side from the inbound SMS, so say what
    // is true of what is on screen.
    group("Plow Account", "The account agents reach this Mac through.", [
      accountBox,
      el("div", { class: "row" }, [relayNote, el("div", { class: "spacer" }), viewAccount, signOut, signIn]),
    ]),
    group("Availability", "Agents can reach this Mac only while Plow Latch is running and the Mac is awake.", [
      el("div", { class: "support-row" }, [
        el("div", { class: "support-copy" }, [
          el("div", { class: "support-title", text: "Launch at Login" }),
          el("p", { class: "faint", text:
            "Open Plow Latch automatically, so a restart doesn't take this Mac off the roster." }),
          launchLabel,
          launchNote,
        ]),
      ]),
      el("div", { class: "support-row" }, [
        el("div", { class: "support-copy" }, [
          el("div", { class: "support-title", text: "Keep Mac Awake" }),
          el("p", { class: "faint", text:
            "Prevent idle and display sleep while plugged in, so the screen never locks out work an agent is doing on it. " +
            "On battery it sleeps normally to conserve power, and closing the lid still sleeps it." }),
          awakeLabel,
        ]),
      ]),
    ]),
    permissions.node,
    group("Software Updates", `Version ${u.currentVersion}`, [
      el("div", { class: "row" }, [updateStatus, el("div", { class: "spacer" }), updateAction]),
      autoCheckLabel,
      autoInstallLabel,
    ]),
    group("Privacy", null, [
      el("div", { class: "support-row" }, [
        el("div", { class: "support-copy" }, [
          el("div", { class: "support-title", text: "Usage Statistics" }),
          el("p", { class: "faint", text:
            "Help improve Plow Latch by sharing which features are used and when something breaks, " +
            "linked to your Plow account. " +
            "Never shared: file paths, commands, goal text, credentials, or anything an agent typed." }),
          statsLabel,
        ]),
      ]),
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
  else if (currentTab === "vault") renderVault(view, () => currentTab === "vault");
  else if (currentTab === "plugins") renderPlugins();
  else if (currentTab === "settings") renderSettings();
}

// Returns whether the switch actually happened. Leaving the Vault replaces the
// whole pane, so an open form with unsaved edits gets a say first — and a caller
// must not persist a tab the owner backed out of.
async function selectTab(tab) {
  if (tab === "rules") tab = "audit";
  // Already there: a rebuild would throw away an open form for no navigation at
  // all, which is the loss this guard exists to prevent.
  if (tab === currentTab) return true;
  if (!(await confirmCurrentTabLeave())) return false;
  if (currentTab === "audit") auditMounted?.gatekeeper.dispose();
  currentTab = tab;
  drawGatekeeperNotice();
  // Leaving Agents closes the fallback: it is a disclosure, and coming back to
  // a form you did not open is a surprise.
  if (tab !== "agents") {
    staticOpen = false;
    closeStaticModal();
    closeMcpModal();
    closeCloudModal();
  }
  if (tab !== "audit") auditMounted = null; // avoid stale refreshes into detached nodes
  if (tab !== "settings") settingsMounted = permissionsMounted = null;
  if (tab !== "plugins") pluginsMounted = null;
  if (tab !== "agents") agentsMounted = null;
  for (const b of seg.querySelectorAll("button")) b.classList.toggle("active", b.dataset.tab === tab);
  render();
  return true;
}

async function confirmCurrentTabLeave() {
  if (currentTab === "vault") return vaultConfirmLeave();
  if (currentTab === "audit" && auditMounted) return auditMounted.gatekeeper.flushPrompt();
  return true;
}

// Let the headless preload probe drive the tabs without synthesising clicks.
window.__domoSelectTab = selectTab;

seg.addEventListener("mousedown", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (await selectTab(btn.dataset.tab)) window.domo.uiSetTab(btn.dataset.tab); // persist across launches
});

window.domo.onAuditChanged((change) => {
  if (currentTab === "audit") refreshAudit({ followTop: true, changed: new Set(change?.ids ?? ["*"]) });
});
// A block by this Mac is an audit row, and the only kind that moves the
// Permissions section's lines and banner — main says so only for those,
// because refreshing the tab takes the standing permission inventory (a
// helper process per switch), which every audit line used to trigger.
window.domo.onCapabilitiesChanged(() => {
  if (currentTab === "plugins") pluginsMounted?.refresh();
  if (currentTab === "settings") permissionsMounted?.refresh();
});
window.domo.onStatusChanged(() => {
  refreshStatus();
  // Signing in or out changes what the account group says, so an open Settings
  // pane has to re-read — main fires this saying "Settings re-reads what
  // changed", and until now only the header did.
  if (currentTab === "settings") settingsMounted?.refresh();
  // Signing in or out changes the roster, whether MCP setup has a URL, and
  // whether the reviewer shown in Audit can run.
  if (currentTab === "agents") agentsMounted?.refreshConnect();
  if (currentTab === "audit") auditMounted?.gatekeeper.refreshMode();
});
// An approval answered "always allow" stored a rule (or a revoke removed one):
// Audit's Gatekeeper card and open rules modal show it without a tab switch.
window.domo.onRulesChanged(() => {
  if (currentTab === "audit") auditMounted?.gatekeeper.refreshRules();
  rulesModal?.refresh();
});
window.domo.onGatekeeperRecoveryChanged(() => {
  void refreshGatekeeperAttention().then(() => {
    if (currentTab === "audit") void refreshAudit({ changed: new Set([selectedId].filter(Boolean)) });
  });
});
// Minting or dismissing a credential redraws only the Agents flow.
window.domo.onConnectChanged(() => { agentsMounted?.refreshConnect(); });
window.domo.onConnectorsChanged((state) => {
  if (currentTab === "settings") permissionsMounted?.applyConnectors(state);
  // Connecting an account can be the requirement a plugin was waiting on.
  if (currentTab === "plugins") pluginsMounted?.refresh();
});
window.domo.onUpdatesChanged(() => {
  refreshUpdateBanner();
  // In place, never renderSettings(): a full rebuild resets the pane's scroll
  // on every background phase change.
  if (currentTab === "settings") settingsMounted?.refreshUpdates();
});
// The menu-bar "Check for Updates…" lands here so its outcome is visible.
// Closing the window or quitting throws an open Vault form away too, so main
// asks here first. A pending agent token must be saved before leaving.
window.domo.onConfirmLeave(async (hasPendingAgentSetup) => {
  if (hasPendingAgentSetup) {
    await selectTab("agents");
    window.domo.confirmLeaveReply(false);
    return;
  }
  window.domo.confirmLeaveReply(await confirmCurrentTabLeave());
});

// Only check once Settings is actually on screen — see checkForUpdatesFromMenu.
window.domo.onShowSettings(async () => {
  if (await selectTab("settings")) window.domo.updatesCheck();
});
// A block by this Mac lands on its switch in Settings; one that named no
// permission goes to onShowAuditBlocked instead.
window.domo.onShowCapabilities(async () => {
  if (await selectTab("settings")) window.domo.uiSetTab("settings");
});
window.domo.onShowAuditBlocked(() => showAuditBlocked());
window.domo.onShowGatekeeperRecovery(() => void showGatekeeperRecovery());
// Another app handed main a credential exchange (Apple Passwords' export):
// land on the Vault tab, whose render finds the staged preview and opens the
// Import sheet on it. Already there means re-render — selectTab dedupes and
// would leave the pane as it is — but never over unsaved edits: an open form
// gets its say first, exactly as a tab switch would give it.
window.domo.onVaultExchange(async () => {
  if (currentTab !== "vault") await selectTab("vault");
  else if (await vaultConfirmLeave()) render();
});
// Granting a permission happens in System Settings, and no event reaches
// this app when it does — the moment a pane can learn the outcome is when
// the person comes back.
window.addEventListener("focus", () => {
  if (currentTab === "agents") void window.domo.cloudRefresh();
  if (currentTab === "settings") {
    settingsMounted?.refresh();
    permissionsMounted?.refresh();
  }
  if (currentTab === "plugins") pluginsMounted?.refresh();
});

// Restore the last-selected tab (falls back to the HTML default on any miss).
async function boot() {
  refreshStatus();
  refreshUpdateBanner();
  void refreshGatekeeperAttention();
  const saved = await window.domo.uiGetTab();
  const known = ["agents", "audit", "vault", "plugins", "settings"];
  selectTab(known.includes(saved) ? saved : "audit");
  // A credential exchange can arrive before this window exists (the system
  // launches the app for it); the push above then had no listener, so ask.
  // Only when landing elsewhere: a boot onto the Vault tab found it already.
  if (currentTab !== "vault" && (await window.domo.vaultExchangePending().catch(() => null))) {
    selectTab("vault");
  }
}
boot();
