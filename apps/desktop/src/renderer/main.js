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

let rulesMounted = null;

async function renderRules() {
  const rules = await window.domo.rulesList();

  // ---- Approvals: what happens when one of those agents asks for something.
  //
  // It sits above the stored rules because both controls answer what agents
  // may do. The stored mode values are untouched — every label below is
  // display only.
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

  // The reads above can outlive a quick tab switch. Do not let the
  // completed Rules render replace the pane the user switched to meanwhile.
  if (currentTab !== "rules") return;

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
          "Until then it denies every request."
        : "";
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
    // Ask mode always gets the reviewer's suggestion — when the reviewer can
    // run. With no credential it can't, so say what is actually true instead.
    if (mode === "ask" && !hasKey) {
      modeHintLine.textContent =
        "Any request a rule doesn't already cover opens an approval window. " +
        `The AI Reviewer has no credential, so it cannot suggest an answer${remedy}`;
    } else if (mode === "approve") {
      modeHintLine.textContent =
        "Every request is allowed without asking you and without review.";
    } else if (mode === "deny") {
      modeHintLine.textContent =
        "Every request is refused without asking you.";
    } else {
      // Unknown stored values keep the card useful by falling back to Ask.
      modeHintLine.textContent = mode === "adversarial" ? "" :
        "Any request a rule doesn't already cover opens an approval window, " +
        "and the AI Reviewer suggests an answer.";
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
  rulesMounted = { refreshApprovals };

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

  view.replaceChildren(el("div", { class: "panel rules settings" }, [
    group(
      "Approvals",
      "What happens when an agent asks to do something on this Mac. Requests already covered " +
        "by an always-allow rule skip Ask and Approve; AI Reviewer and Deny still apply to every " +
        "request. Manage those rules below. The reviewer sees which " +
        "agent is asking, what it's asking to do, the exact bounds it would get, and the purpose " +
        "you wrote for it. It never sees your files, your history on this Mac, or anything the " +
        "agent hasn't asked for.",
      [modeChips, modeNote, purposeBlock, modeHintLine],
    ),
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

function focusCloudAgent(agentId) {
  const row = [...document.querySelectorAll(".cloud-agent-row")]
    .find((candidate) => candidate.dataset.cloudAgentId === agentId);
  row?.querySelector(".cloud-agent-open")?.focus();
}

function dismissCloudCreateModal() {
  if (cloudModal?.kind === "create" && cloudModal.started && cloudModal.phase === "creating") {
    return;
  }
  if (cloudModal?.kind === "create") void window.domo.cloudCancelCreate();
  closeCloudModal();
}

function cloudCreateProgress(
  panel,
  text,
  cancellable = true,
  title = "New agent",
  onCancel = dismissCloudCreateModal,
) {
  const cancel = cancellable ? el("button", { class: "btn", text: "Cancel" }) : null;
  cancel?.addEventListener("click", onCancel);
  panel.replaceChildren(
    el("div", { class: "group-title", text: title }),
    el("div", { class: "cloud-progress" }, [
      el("span", { class: "cloud-spinner", attrs: { "aria-hidden": "true" } }),
      el("span", { text }),
    ]),
    el("div", { class: "row cloud-modal-actions" }, [
      el("div", { class: "spacer" }),
      cancel,
    ]),
  );
  cancel?.focus();
}

function cloudActivationScreen(panel, flow, onCancel) {
  const cancel = el("button", { class: "btn", text: "Cancel" });
  const messages = el("button", { class: "btn primary", text: "Open Messages…" });
  cancel.addEventListener("click", onCancel);
  messages.addEventListener("click", () => window.domo.cloudOpenMessages());
  panel.replaceChildren(
    el("div", { class: "group-title", text: "New line" }),
    el("p", {
      class: "conn-note",
      text: `Text this code to ${flow.activation.sendTo} from your phone.`,
    }),
    el("div", { class: "cloud-activation-code mono", text: flow.activation.displayCode }),
    el("div", { class: "field" }, [
      el("label", { text: "Send this exact message" }),
      copyRow(flow.activation.smsBody, "Copy"),
    ]),
    ...(flow.message ? [el("p", { class: "faint modal-note", text: flow.message })] : []),
    el("div", { class: "row cloud-modal-actions" }, [
      cancel,
      el("div", { class: "spacer" }),
      messages,
    ]),
  );
  messages.focus();
}

function cloudLinePickerNodes(state, start, cancel, message = null) {
  if (state.cloudChatsLoaded !== true) {
    const unavailable = state.cloudChatsError
      ? cloudErrorCopy(state.cloudChatsError)
      : "Your lines couldn't be loaded yet. Try again.";
    return [
      el("div", { class: "cloud-callout cloud-error" }, [
        el("div", { class: "cloud-callout-title", text: "Lines could not be loaded" }),
        el("p", { class: "faint", text: unavailable }),
      ]),
      el("div", { class: "row cloud-modal-actions" }, [cancel]),
    ];
  }
  const freeLines = state.cloudFreeLines ?? [];
  const lineChoices = freeLines.map((line) => {
    const choose = el("button", { class: "cloud-line-option", text: line.label });
    choose.addEventListener("click", () => start(line.uid));
    return choose;
  });
  const newLine = el("button", { class: "btn primary", text: "New line" });
  newLine.addEventListener("click", () => start(null));
  return [
    ...(message ? [el("div", { class: "cloud-callout cloud-error" }, [
      el("p", { class: "faint", text: cloudErrorCopy(message) }),
    ])] : []),
    ...(lineChoices.length ? [
      el("div", { class: "cloud-line-heading", text: "Your free lines" }),
      el("div", { class: "cloud-line-options" }, lineChoices),
    ] : []),
    el("div", { class: "cloud-new-line" }, [
      el("p", {
        class: "faint",
        text: "Create a new number by texting a one-time code from your phone.",
      }),
      newLine,
    ]),
    el("div", { class: "row cloud-modal-actions" }, [cancel]),
  ];
}

function syncCloudCreateModal(state, redraw) {
  if (cloudModal?.kind !== "create") return;
  const modal = cloudModal;
  const flow = state.cloudCreate ?? { phase: "idle" };
  const { panel, nameInput } = modal;
  modal.phase = flow.phase;

  if (modal.started && flow.createdAgentId) {
    const createdAgentId = flow.createdAgentId;
    closeCloudModal();
    focusCloudAgent(createdAgentId);
    return;
  }

  if (modal.started && flow.phase === "activating") {
    cloudCreateProgress(panel, "Getting a new line from Plow…");
    return;
  }
  if (modal.started && flow.phase === "creating") {
    cloudCreateProgress(panel, "Setting up the agent…", false);
    return;
  }

  if (modal.started && flow.phase === "waiting" && flow.activation) {
    cloudActivationScreen(panel, flow, dismissCloudCreateModal);
    return;
  }

  if (modal.started && flow.phase === "error") {
    const cancel = el("button", { class: "btn", text: "Cancel" });
    const retry = el("button", {
      class: "btn primary",
      text: flow.retryNewLine ? "Retry New agent" : "Try again",
    });
    cancel.addEventListener("click", dismissCloudCreateModal);
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      cancel.disabled = true;
      await window.domo.cloudRetryCreate();
      await redraw();
    });
    panel.replaceChildren(
      el("div", { class: "group-title", text: "New agent" }),
      el("div", { class: "cloud-callout cloud-error" }, [
        el("div", { class: "cloud-callout-title", text: "The agent wasn't created" }),
        el("p", {
          class: "faint",
          text: cloudErrorCopy(flow.message || "Something went wrong. Try again."),
        }),
      ]),
      el("div", { class: "row cloud-modal-actions" }, [
        cancel,
        el("div", { class: "spacer" }),
        retry,
      ]),
    );
    retry.focus();
    return;
  }

  const start = async (lineUid) => {
    modal.started = true;
    modal.phase = lineUid === null ? "activating" : "creating";
    cloudCreateProgress(
      panel,
      lineUid === null ? "Getting a new line from Plow…" : "Setting up the agent…",
      lineUid === null,
    );
    await window.domo.cloudCreate({ name: nameInput.value.trim(), lineUid });
    await redraw();
  };
  const cancel = el("button", { class: "btn", text: "Cancel" });
  cancel.addEventListener("click", dismissCloudCreateModal);
  panel.replaceChildren(
    el("div", { class: "group-title", text: "New agent" }),
    el("div", { class: "field cloud-agent-name" }, [
      el("label", { text: "Name (optional)" }),
      nameInput,
    ]),
    ...cloudLinePickerNodes(state, start, cancel),
  );
  if (modal.firstPaint) {
    modal.firstPaint = false;
    nameInput.focus();
  }
}

function openCloudCreate(trigger, state, redraw) {
  const nameInput = el("input", {
    class: "text",
    attrs: { placeholder: "Cloud agent", "aria-label": "Agent name" },
  });
  if (!openCloudModal(trigger, [], nameInput, dismissCloudCreateModal)) return;
  Object.assign(cloudModal, {
    kind: "create",
    nameInput,
    started: false,
    phase: "idle",
    firstPaint: true,
  });
  cloudCreateProgress(cloudModal.panel, "Loading your lines…");
  void (async () => {
    await window.domo.cloudCancelCreate();
    const refreshed = await window.domo.cloudRefresh();
    if (cloudModal?.kind === "create") syncCloudCreateModal(refreshed ?? state, redraw);
  })();
}

function dismissCloudChangeLineModal() {
  if (cloudModal?.kind === "change-line" && cloudModal.phase === "creating") return;
  if (cloudModal?.kind === "change-line") void window.domo.cloudCancelChangeLine();
  closeCloudModal();
}

function syncCloudChangeLineModal(state, redraw) {
  if (cloudModal?.kind !== "change-line") return;
  const modal = cloudModal;
  const agent = (state.cloudAgents ?? [])
    .find((candidate) => candidate.agentId === modal.agentId);
  if (!agent) {
    void window.domo.cloudCancelChangeLine();
    closeCloudModal();
    return;
  }
  const flow = state.cloudChangeLine ?? { phase: "idle" };
  modal.phase = flow.phase;

  if (modal.started && flow.changedAgentId) {
    const changedAgentId = flow.changedAgentId;
    closeCloudModal();
    focusCloudAgent(changedAgentId);
    return;
  }
  if (modal.started && flow.phase === "activating") {
    cloudCreateProgress(
      modal.panel,
      "Getting a new line from Plow…",
      true,
      "Change line",
      dismissCloudChangeLineModal,
    );
    return;
  }
  if (modal.started && flow.phase === "creating") {
    cloudCreateProgress(
      modal.panel,
      "Moving the agent…",
      false,
      "Change line",
      dismissCloudChangeLineModal,
    );
    return;
  }
  if (modal.started && flow.phase === "waiting" && flow.activation) {
    cloudActivationScreen(modal.panel, flow, dismissCloudChangeLineModal);
    return;
  }
  if (modal.started && flow.phase === "error") {
    const cancel = el("button", { class: "btn", text: "Cancel" });
    const retry = el("button", { class: "btn primary", text: "Try again" });
    cancel.addEventListener("click", dismissCloudChangeLineModal);
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      cancel.disabled = true;
      await window.domo.cloudRetryChangeLine();
      await redraw();
    });
    modal.panel.replaceChildren(
      el("div", { class: "group-title", text: "Change line" }),
      el("div", { class: "cloud-callout cloud-error" }, [
        el("div", { class: "cloud-callout-title", text: "The line wasn't changed" }),
        el("p", {
          class: "faint",
          text: cloudErrorCopy(flow.message || "Something went wrong. Try again."),
        }),
      ]),
      el("div", { class: "row cloud-modal-actions" }, [
        cancel,
        el("div", { class: "spacer" }),
        retry,
      ]),
    );
    retry.focus();
    return;
  }

  modal.started = false;
  const start = async (lineUid) => {
    modal.started = true;
    modal.phase = lineUid === null ? "activating" : "creating";
    cloudCreateProgress(
      modal.panel,
      lineUid === null ? "Getting a new line from Plow…" : "Moving the agent…",
      lineUid === null,
      "Change line",
      dismissCloudChangeLineModal,
    );
    await window.domo.cloudChangeLine({ agentId: agent.agentId, lineUid });
    await redraw();
  };
  const cancel = el("button", { class: "btn", text: "Cancel" });
  cancel.addEventListener("click", dismissCloudChangeLineModal);
  modal.panel.replaceChildren(
    el("div", { class: "group-title", text: "Change line" }),
    el("p", {
      class: "conn-note",
      text: "The agent keeps its name and memory and moves to the new number.",
    }),
    ...cloudLinePickerNodes(state, start, cancel, flow.message),
  );
  modal.panel.querySelector(".cloud-line-option, .cloud-new-line button")?.focus();
}

function openCloudChangeLine(agent, state, redraw) {
  if (!cloudModal) return;
  Object.assign(cloudModal, {
    kind: "change-line",
    agentId: agent.agentId,
    started: false,
    phase: "idle",
    dismiss: dismissCloudChangeLineModal,
  });
  cloudCreateProgress(
    cloudModal.panel,
    "Loading your lines…",
    true,
    "Change line",
    dismissCloudChangeLineModal,
  );
  void (async () => {
    await window.domo.cloudCancelChangeLine();
    const refreshed = await window.domo.cloudRefresh();
    if (cloudModal?.kind === "change-line") {
      syncCloudChangeLineModal(refreshed ?? state, redraw);
    }
  })();
}

/** Repaint the open agent detail from the same state as the roster behind it. */
function syncCloudModal(state, redraw) {
  if (!cloudModal) return;
  if (cloudModal.kind === "create") {
    syncCloudCreateModal(state, redraw);
    return;
  }
  if (cloudModal.kind === "change-line") {
    syncCloudChangeLineModal(state, redraw);
    return;
  }
  const agent = (state.cloudAgents ?? [])
    .find((candidate) => candidate.agentId === cloudModal.agentId);
  if (!agent) {
    closeCloudModal();
    return;
  }
  const { panel } = cloudModal;
  const name = agent.name || "Cloud agent";

  const showDetail = () => {
    cloudModal.confirmingDelete = false;
    const close = el("button", { class: "btn", text: "Close" });
    const changeLine = agent.status === "failed"
      ? null
      : el("button", { class: "btn", text: "Change line" });
    const remove = el("button", { class: "btn danger", text: "Delete agent" });
    close.addEventListener("click", closeCloudModal);
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
        text: agent.line
          ? "The agent will stop reading and replying on this line."
          : "The agent will stop reading and replying in its fixed threads.",
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

function rosterName(row, fallback) {
  return row?.name?.trim() || fallback;
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

function rosterUse(row, verb = "Last used") {
  const seen = rosterAgo(row?.lastSeenAt);
  if (seen) return `${verb} ${seen}`;
  const created = rosterDate(row?.createdAt);
  return created ? `Never used · Created ${created}` : "Never used";
}

function rosterChatGrant(chatUids, chatAccess) {
  const chats = Array.isArray(chatUids) ? chatUids : [];
  if (chatAccess === "all") return "all chats";
  if (chatAccess === "none") return "no chats";
  if (!chats.length) return "no chats";
  if (chats.length === 1 && chats[0] === "*") return "all chats";
  return chats.length === 1 ? "1 chat" : `${chats.length} chats`;
}

function rosterPermissionCopy(row, provisioning = false) {
  const permissions = [];
  if (row?.permissions?.canReadAndReply === true) {
    permissions.push(
      `${provisioning ? "Will read and reply" : "Reads and replies"} in ${rosterChatGrant(row.chatUids, row.chatAccess)}`,
    );
  }
  if (row?.permissions?.canReachMac === true) {
    permissions.push(`${provisioning ? "Will reach" : "Can reach"} this Mac`);
  }
  if (row?.permissions?.canSpendInference === true) permissions.push("Can spend inference");
  if (!permissions.length) {
    permissions.push(row ? "No agent permissions granted." : "No granted permissions known.");
  }
  return permissions;
}

function entityMark(name, client = false) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const text = client
    ? words.slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "?"
    : (words[0]?.[0] || "?").toUpperCase();
  return el("span", { class: `entity-mark${client ? " client" : ""}`, text });
}

function rosterBadge(row) {
  if (row.isThisMac) return badge("blue", "This Mac");
  if (row.kind === "Plow web login") return badge("zinc", "Web login");
  if (row.kind === "Legacy — full access") return badge("amber", "Legacy *:*");
  if (row.kind === "Session") return badge("zinc", "Session");
  return null;
}

function closeRosterConfirm(shell) {
  if (shell) closeModal(shell);
}

function openRosterConfirm(row, trigger, redraw) {
  const name = rosterName(row, "Unnamed session");
  const destructive = "Revoke";
  let title = `Revoke ${name}?`;
  let copy = "Any client or session using this credential will stop working.";
  if (row.isThisMac) {
    title = "Sign this Mac out?";
    copy = "Revoking this credential immediately signs this Mac out and stops agents from reaching it.";
  } else if (row.kind === "Plow web login") {
    copy = "Revoking this session signs you out of the Plow website.";
  }
  const cancel = el("button", { class: "btn", text: "Cancel" });
  const confirm = el("button", { class: "btn danger", text: destructive });
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
    className: row.isThisMac ? "roster-confirm roster-confirm-loud" : "roster-confirm",
    focus: cancel,
    onDismiss: dismiss,
    children: [
      el("div", { class: "group-title", text: title }),
      el("p", { class: row.isThisMac ? "warn conn-note" : "conn-note", text: copy }),
      note,
      el("div", { class: "row conn-actions" }, [cancel, el("div", { class: "spacer" }), confirm]),
    ],
  });
}

function rosterActions(
  row,
  section,
  redraw,
) {
  const name = rosterName(row, section === "mcp" ? "Unnamed MCP client" : "Unnamed session");
  const actions = [];
  const more = el("button", {
    class: "btn more",
    text: "⋯",
    attrs: { "aria-label": `More actions for ${name}` },
  });
  const action = el("button", { text: "Revoke" });
  const menu = el("div", { class: "more-menu", attrs: { role: "menu" } }, [action]);
  menu.hidden = true;
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    for (const open of document.querySelectorAll(".more-menu:not([hidden])")) {
      if (open !== menu) open.hidden = true;
    }
    menu.hidden = !menu.hidden;
  });
  action.addEventListener("click", () => {
    menu.hidden = true;
    openRosterConfirm(row, more, redraw);
  });
  actions.push(more, menu);
  return el("div", { class: "entity-actions" }, actions);
}

function cloudContext(agent, row) {
  return [
    cloudLine(agent),
    rosterUse(row ?? { createdAt: agent?.createdAt, lastSeenAt: null }, "Used"),
  ].filter(Boolean).join(" · ");
}

function cloudStatusNode(agent) {
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

function cloudEntityRow(row, agent, state, redraw) {
  const name = rosterName(row, agent?.name || "Cloud agent");
  const main = el("div", {
    class: `entity-main${agent ? " cloud-agent-open" : ""}`,
    attrs: agent
      ? { role: "button", tabindex: "0", "aria-label": `View ${name}` }
      : {},
  }, [
    el("div", { class: "entity-top" }, [
      el("span", { class: "entity-name", text: name }),
      cloudStatusNode(agent),
    ]),
    el("div", {
      class: "entity-context",
      text: cloudContext(agent, row),
      attrs: { title: cloudContext(agent, row) },
    }),
  ]);
  if (agent) {
    main.addEventListener("click", () => openCloudDetail(main, agent, state, redraw));
    main.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openCloudDetail(main, agent, state, redraw);
    });
  }
  const retry = agent?.status === "failed"
    ? el("button", { class: "btn small", text: "Retry" })
    : null;
  retry?.addEventListener("click", async () => {
    retry.disabled = true;
    await window.domo.cloudRetryFailed(agent.agentId);
    await redraw();
  });
  return el("div", { class: "entity-row cloud-agent-row", attrs: { "data-cloud-agent-id": agent?.agentId ?? row?.agentId ?? "" } }, [
    entityMark(name),
    main,
    retry ? el("div", { class: "entity-actions" }, [retry]) : null,
  ]);
}

function sessionEntityRow(row, section, redraw) {
  const fallback = section === "mcp" ? "Unnamed MCP client" : "Unnamed session";
  const name = rosterName(row, fallback);
  const context = [
    section === "mcp" ? "MCP client" : row.kind,
    row.createdAt ? `Created ${rosterDate(row.createdAt) ?? "date unknown"}` : "Created date unknown",
    row.lastSeenAt ? `Last used ${rosterAgo(row.lastSeenAt) ?? "date unknown"}` : "Never used",
  ].join(" · ");
  const permissions = rosterPermissionCopy(row);
  if (row.kind === "Plow web login") permissions.push("Revoking signs you out of the Plow website");
  if (row.isThisMac) permissions.push("Revoking signs this Mac out");
  return el("div", { class: "entity-row" }, [
    entityMark(name, true),
    el("div", { class: "entity-main" }, [
      el("div", { class: "entity-top" }, [
        el("span", { class: "entity-name", text: name }),
        rosterBadge(row),
      ]),
      el("div", { class: "entity-context", text: context }),
      el("div", { class: "entity-perms" }, permissions.map((text) =>
        el("span", {
          class: text.startsWith("Revoking") ? "signout-warning" : "",
          text,
        }),
      )),
    ]),
    rosterActions(row, section, redraw),
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

function cloudSection(s, redraw) {
  const add = el("button", { class: "btn primary", text: "New agent" });
  add.addEventListener("click", () => openCloudCreate(add, s, redraw));
  const rosterRows = s.roster?.cloud ?? [];
  const agents = s.cloudAgents;
  const byAgentId = new Map(agents.map((agent) => [agent.agentId, agent]));
  const seen = new Set();
  const rows = rosterRows.map((row) => {
    seen.add(row.agentId);
    return cloudEntityRow(row, byAgentId.get(row.agentId), s, redraw);
  });
  for (const agent of agents) {
    if (!seen.has(agent.agentId)) rows.push(cloudEntityRow(null, agent, s, redraw));
  }
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
    sectionHeader("Cloud agents", rows.length, "agent", add),
    ...notices,
    el("div", { class: "entity-list compact-list" }, rows.length
      ? rows
      : [el("div", { class: "empty entity-empty", text: "No cloud agents." })]),
  ]);
}

function sessionSection(title, rows, section, s, redraw) {
  const action = section === "mcp"
    ? (() => {
        const add = el("button", { class: "btn small", text: "Connect MCP client" });
        add.addEventListener("click", () => openMcpModal(add, s, redraw));
        return add;
      })()
    : null;
  const unit = section === "mcp" ? "client" : "active session";
  const children = rows.map((row) => sessionEntityRow(row, section, redraw));
  if (section === "other" && s.roster.revokedHidden > 0) {
    const count = s.roster.revokedHidden;
    children.push(el("div", {
      class: "revoked-summary",
      text: `${count} revoked session${count === 1 ? "" : "s"} hidden`,
    }));
  }
  return el("section", { class: "list-section" }, [
    sectionHeader(title, rows.length, unit, action),
    el("div", { class: "entity-list compact-list" }, children.length
      ? children
      : [el("div", { class: "empty entity-empty", text: `No ${title.toLowerCase()}.` })]),
  ]);
}

function rosterNotice(s) {
  if (!s.rosterError && !s.removeError) return null;
  return el("div", { class: "roster-notices" }, [
    s.rosterError ? cloudErrorBanner(s.rosterError, "Sessions could not be refreshed") : null,
    s.removeError ? cloudErrorBanner(s.removeError, "That session was not removed") : null,
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
      sessionSection("MCP clients", s.roster?.mcp ?? [], "mcp", s, refreshConnect),
      sessionSection("Other sessions", s.roster?.other ?? [], "other", s, refreshConnect),
    ].filter(Boolean));
    syncCloudModal(s, refreshConnect);
    syncMcpModal(s, refreshConnect);
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
  if (tab !== "agents") {
    staticOpen = false;
    closeStaticModal();
    closeMcpModal();
    closeCloudModal();
  }
  if (tab !== "audit") auditMounted = null; // avoid stale refreshes into detached nodes
  if (tab !== "settings") settingsMounted = null;
  if (tab !== "agents") agentsMounted = null;
  if (tab !== "rules") rulesMounted = null;
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
  // Signing in or out changes the roster, whether MCP setup has a URL, and
  // whether the reviewer shown in Rules can run.
  if (currentTab === "agents") agentsMounted?.refreshConnect();
  if (currentTab === "rules") rulesMounted?.refreshApprovals();
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
