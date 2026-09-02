/* Main-window renderer. Sandboxed: no Node, no ipcRenderer — only the narrow
   `window.domo` bridge from preload. All agent-derived text is inserted with
   textContent (never innerHTML), so nothing on the wire can inject markup. */

import {
  PURPOSE_CAVEATS,
  PURPOSE_LABEL,
  PURPOSE_PLACEHOLDER,
} from "./approvals.js";

import { el, icon } from "./dom.js";
import { googleConnectorCard } from "./connectorsCard.js";
import { singleFlight } from "./onboardingAction.js";
import { renderVault, vaultConfirmLeave } from "./vault.js";
import {
  cloudErrorCopy,
  cloudProviderPickerViewModel,
} from "../cloudAgentViewModel.js";

const view = document.getElementById("view");
const seg = document.getElementById("seg");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const NEW_LINE_VALUE = "__new_line__";

// Null until boot() picks one: the HTML marks Audit active for the first paint,
// but boot must still RENDER that pane, and "already on this tab" now returns
// early — so the starting value cannot be a tab boot might legitimately select.
let currentTab = null;
let filter = "all";
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
  // Click the thumbnail to blow it up over the window; click again (anywhere on
  // the blown-up view) to shrink it back to the corner.
  liveBox.addEventListener("click", () => liveBox.classList.toggle("expanded"));
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
    if (!s.active) {
      m.liveHasFrame = false; // next session starts with a fresh frame
      m.liveBox.classList.remove("expanded"); // never leave the overlay up with no session
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
      staticModal.lineSelect = el("select", { class: "text", attrs: { "aria-label": "Line" } });
      const create = async () => {
        await window.domo.connectCreate(staticModal.nameInput.value, staticModal.lineSelect.value || null);
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
        el("div", { class: "field" }, [el("label", { text: "Line" }), staticModal.lineSelect]),
        el("p", {
          class: "faint conn-note",
          text: "Pick the line this agent answers on to give it its model and its Mac. Leave blank for a tool that only needs MCP.",
        }),
        note,
        el("div", { class: "row conn-actions" }, [cancel, el("div", { class: "spacer" }), createBtn]),
      );
      staticModal.nameInput.focus();
    }
  }
  // The lines arrive with the cloud state, which can land after this modal is
  // already up — so the options are refilled on every refresh, in place,
  // keeping whatever was picked.
  if (kind === "form") {
    staticModal.lineSelect.disabled = !!s.busy;
    const lines = s.cloudFreeLines ?? [];
    const picked = staticModal.lineSelect.value;
    staticModal.lineSelect.replaceChildren(
      el("option", { text: "No line — MCP access only", attrs: { value: "" } }),
      ...lines.map((line) => el("option", { text: line.label, attrs: { value: line.uid } })),
    );
    staticModal.lineSelect.value = picked;
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

function cloudLine(agent, state) {
  if (agent?.line?.label) return agent.line.label;
  return state.cloudChatsLoaded === true && !state.cloudChatsError
    ? "No line"
    : "Line unavailable";
}

function focusCloudAgent(agentId) {
  const row = [...document.querySelectorAll(".cloud-agent-row")]
    .find((candidate) => candidate.dataset.cloudAgentId === agentId);
  row?.querySelector(".cloud-agent-open")?.focus();
}

function dismissCloudLineModal() {
  if (cloudModal?.kind === "line-flow" && cloudModal.phase === "creating") return;
  if (cloudModal?.kind === "line-flow") void window.domo.cloudCancelLineFlow();
  closeCloudModal();
}

function cloudLineProgress(
  panel,
  text,
  cancellable = true,
  title = "New agent",
) {
  const cancel = cancellable ? el("button", { class: "btn", text: "Cancel" }) : null;
  cancel?.addEventListener("click", dismissCloudLineModal);
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

function cloudActivationScreen(panel, flow) {
  const cancel = el("button", { class: "btn", text: "Cancel" });
  const messages = el("button", { class: "btn primary", text: "Open Messages…" });
  cancel.addEventListener("click", dismissCloudLineModal);
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

function cloudLinePickerNodes(state, modal, start, cancel, message = null) {
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
  const lineSelect = el("select", {
    class: "text",
    attrs: { "aria-label": "Line" },
  }, [
    el("option", { text: "Choose a line…", attrs: { value: "", disabled: "" } }),
    ...freeLines.map((line) => el("option", { text: line.label, attrs: { value: line.uid } })),
    el("option", { text: "New line", attrs: { value: NEW_LINE_VALUE } }),
  ]);
  const available = new Set(freeLines.map((line) => line.uid));
  if (modal.selectedLineUid !== undefined && modal.selectedLineUid !== null &&
      !available.has(modal.selectedLineUid)) {
    modal.selectedLineUid = undefined;
  }
  lineSelect.value = modal.selectedLineUid === null
    ? NEW_LINE_VALUE
    : modal.selectedLineUid ?? "";
  const submit = el("button", {
    class: "btn primary",
    text: modal.mode === "change" ? "Change line" : "Create agent",
  });
  submit.disabled = modal.selectedLineUid === undefined;
  lineSelect.addEventListener("change", () => {
    modal.selectedLineUid = lineSelect.value === NEW_LINE_VALUE
      ? null
      : lineSelect.value || undefined;
    submit.disabled = modal.selectedLineUid === undefined;
  });
  submit.addEventListener("click", () => {
    if (modal.selectedLineUid !== undefined) start(modal.selectedLineUid);
  });
  return [
    ...(message ? [el("div", { class: "cloud-callout cloud-error" }, [
      el("p", { class: "faint", text: cloudErrorCopy(message) }),
    ])] : []),
    el("div", { class: "field cloud-agent-line" }, [
      el("label", { text: "Line" }),
      lineSelect,
    ]),
    el("div", { class: "row cloud-modal-actions" }, [
      cancel,
      el("div", { class: "spacer" }),
      submit,
    ]),
  ];
}

function cloudLineConfirmed(panel, title) {
  panel.replaceChildren(
    el("div", { class: "group-title", text: title }),
    el("div", { class: "cloud-confirmed", text: "Code confirmed" }),
    el("p", { class: "faint modal-note", text: "Setting up your agent…" }),
  );
}

function syncCloudLineModal(state, redraw) {
  if (cloudModal?.kind !== "line-flow") return;
  const modal = cloudModal;
  const changing = modal.mode === "change";
  const title = changing ? "Change line" : "New agent";
  const agent = changing
    ? (state.cloudAgents ?? []).find((candidate) => candidate.agentId === modal.agentId)
    : null;
  if (changing && !agent) {
    void window.domo.cloudCancelLineFlow();
    closeCloudModal();
    return;
  }
  const flow = state.cloudLineFlow ?? { phase: "idle" };
  const { panel } = modal;
  modal.phase = flow.phase;

  const providers = changing ? null : state.cloudProviders;
  const providerView = cloudProviderPickerViewModel(
    providers,
    state.cloudProvidersError,
  );
  if (!changing && !modal.started && providers) {
    const selected = modal.providerSelect.value;
    modal.providerSelect.replaceChildren(...providers.map((provider) =>
      el("option", { text: provider.name, attrs: { value: provider.id } })));
    if (providers.some((provider) => provider.id === selected)) {
      modal.providerSelect.value = selected;
    }
  }

  if (!changing && !modal.started && providerView.mode === "blocked") {
    const cancel = el("button", { class: "btn", text: "Cancel" });
    cancel.addEventListener("click", dismissCloudLineModal);
    panel.replaceChildren(
      el("div", { class: "group-title", text: title }),
      cloudErrorBanner(providerView.message, providerView.heading),
      el("div", { class: "row cloud-modal-actions" }, [cancel]),
    );
    cancel.focus();
    return;
  }

  if (modal.started && flow.completedAgentId) {
    const completedAgentId = flow.completedAgentId;
    if (modal.selectedLineUid === null) {
      if (!modal.confirmationTimer) {
        const confirmedModal = modal;
        modal.phase = "confirmed";
        cloudLineConfirmed(panel, title);
        modal.confirmationTimer = setTimeout(() => {
          if (cloudModal !== confirmedModal) return;
          closeCloudModal();
          focusCloudAgent(completedAgentId);
        }, 1_500);
      }
      return;
    }
    closeCloudModal();
    focusCloudAgent(completedAgentId);
    return;
  }

  if (modal.started && flow.phase === "activating") {
    cloudLineProgress(panel, "Getting a new line from Plow…", true, title);
    return;
  }
  if (modal.started && flow.phase === "creating") {
    cloudLineProgress(panel, changing ? "Moving the agent…" : "Setting up the agent…", false, title);
    return;
  }

  if (modal.started && flow.phase === "waiting" && flow.activation) {
    cloudActivationScreen(panel, flow);
    return;
  }

  if (modal.started && flow.phase === "error" && flow.terminal === "no_numbers") {
    const close = el("button", { class: "btn primary", text: "Close" });
    close.addEventListener("click", dismissCloudLineModal);
    panel.replaceChildren(
      el("div", { class: "group-title", text: title }),
      el("div", { class: "cloud-callout cloud-error" }, [
        el("p", {
          class: "faint",
          text: "No numbers are available right now. Try again later.",
        }),
      ]),
      el("div", { class: "row cloud-modal-actions" }, [
        el("div", { class: "spacer" }),
        close,
      ]),
    );
    close.focus();
    return;
  }

  if (modal.started && flow.phase === "error") {
    const cancel = el("button", { class: "btn", text: "Cancel" });
    const retry = el("button", {
      class: "btn primary",
      text: !changing && flow.retryNewLine ? "Retry New agent" : "Try again",
    });
    cancel.addEventListener("click", dismissCloudLineModal);
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      cancel.disabled = true;
      await window.domo.cloudRetryLineFlow();
      await redraw();
    });
    panel.replaceChildren(
      el("div", { class: "group-title", text: title }),
      el("div", { class: "cloud-callout cloud-error" }, [
        el("div", {
          class: "cloud-callout-title",
          text: changing ? "The line wasn't changed" : "The agent wasn't created",
        }),
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

  if (modal.started && flow.phase === "idle") {
    modal.started = false;
    modal.selectedLineUid = undefined;
  }

  const start = async (lineUid) => {
    modal.started = true;
    modal.phase = lineUid === null ? "activating" : "creating";
    cloudLineProgress(
      panel,
      lineUid === null
        ? "Getting a new line from Plow…"
        : changing ? "Moving the agent…" : "Setting up the agent…",
      lineUid === null,
      title,
    );
    if (changing) {
      await window.domo.cloudChangeLine({ agentId: agent.agentId, lineUid });
    } else {
      await window.domo.cloudCreate({
        name: modal.nameInput.value.trim(),
        provider: modal.providerSelect.value,
        lineUid,
      });
    }
    await redraw();
  };
  const cancel = el("button", { class: "btn", text: "Cancel" });
  cancel.addEventListener("click", dismissCloudLineModal);
  panel.replaceChildren(
    el("div", { class: "group-title", text: title }),
    ...(changing ? [el("p", {
      class: "conn-note",
      text: "The agent keeps its name and memory and moves to the new number.",
    })] : [el("div", { class: "field cloud-agent-name" }, [
      el("label", { text: "Name (optional)" }),
      modal.nameInput,
    ]), el("div", { class: "field" }, [
      el("label", { text: "Agent type" }),
      modal.providerSelect,
    ])]),
    ...cloudLinePickerNodes(state, modal, start, cancel, changing ? flow.message : null),
  );
  if (modal.firstPaint) {
    modal.firstPaint = false;
    if (changing) panel.querySelector('select[aria-label="Line"]')?.focus();
    else modal.nameInput.focus();
  }
}

function openCloudCreate(trigger, state, redraw) {
  const nameInput = el("input", {
    class: "text",
    attrs: { placeholder: "Cloud agent", "aria-label": "Agent name" },
  });
  const providerSelect = el("select", {
    class: "text",
    attrs: { "aria-label": "Agent type" },
  });
  if (!openCloudModal(trigger, [], nameInput, dismissCloudLineModal)) return;
  Object.assign(cloudModal, {
    kind: "line-flow",
    mode: "create",
    nameInput,
    providerSelect,
    selectedLineUid: undefined,
    started: false,
    phase: "idle",
    firstPaint: true,
  });
  cloudLineProgress(cloudModal.panel, "Loading your lines…");
  void (async () => {
    await window.domo.cloudCancelLineFlow();
    const refreshed = await window.domo.cloudRefresh();
    if (cloudModal?.kind === "line-flow") syncCloudLineModal(refreshed ?? state, redraw);
  })();
}

function openCloudChangeLine(agent, state, redraw) {
  if (!cloudModal) return;
  Object.assign(cloudModal, {
    kind: "line-flow",
    mode: "change",
    agentId: agent.agentId,
    selectedLineUid: undefined,
    started: false,
    phase: "idle",
    firstPaint: true,
    dismiss: dismissCloudLineModal,
  });
  cloudLineProgress(
    cloudModal.panel,
    "Loading your lines…",
    true,
    "Change line",
  );
  void (async () => {
    await window.domo.cloudCancelLineFlow();
    const refreshed = await window.domo.cloudRefresh();
    if (cloudModal?.kind === "line-flow") {
      syncCloudLineModal(refreshed ?? state, redraw);
    }
  })();
}

/** Repaint the open agent detail from the same state as the roster behind it. */
function syncCloudModal(state, redraw) {
  if (!cloudModal) return;
  if (cloudModal.kind === "line-flow") {
    syncCloudLineModal(state, redraw);
    return;
  }
  const agent = (state.cloudAgents ?? [])
    .find((candidate) => candidate.agentId === cloudModal.agentId);
  if (!agent) {
    closeCloudModal();
    return;
  }
  const { panel } = cloudModal;
  const credentialRow = (state.roster?.cloud ?? []).find((row) => row.agentId === agent.agentId);
  const name = rosterName(credentialRow, agent.name || "Cloud agent");

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
          el("span", { text: cloudLine(agent, state) }),
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
        text: "The agent will stop reading and replying.",
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
  if (row.kind === "Admin — full access") return badge("amber", "Admin *:*");
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

function openRosterRename(row, trigger, redraw, fallback) {
  const current = rosterName(row, "");
  const input = el("input", {
    class: "text",
    attrs: { placeholder: "Name", maxlength: "200", "aria-label": "New name" },
  });
  input.value = current;
  const cancel = el("button", { class: "btn", text: "Cancel" });
  const save = el("button", { class: "btn primary", text: "Save" });
  const note = el("p", { class: "faint modal-note", text: "" });
  let shell = null;
  const dismiss = () => closeRosterConfirm(shell);
  const submit = async () => {
    const name = input.value.trim();
    if (!name) {
      note.textContent = "A name is required.";
      input.focus();
      return;
    }
    cancel.disabled = true;
    save.disabled = true;
    input.disabled = true;
    note.textContent = "Saving…";
    try {
      await window.domo.rosterRename(row.id, name);
    } finally {
      dismiss();
      await redraw();
    }
  };
  cancel.addEventListener("click", dismiss);
  save.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void submit();
  });
  shell = openModal(trigger, {
    className: "roster-confirm",
    focus: input,
    onDismiss: dismiss,
    children: [
      el("div", { class: "group-title", text: `Rename ${current || fallback}` }),
      row.isThisMac
        ? el("p", { class: "conn-note", text: "Renames this Mac's Plow session, not the Mac." })
        : null,
      input,
      note,
      el("div", { class: "row conn-actions" }, [cancel, el("div", { class: "spacer" }), save]),
    ],
  });
  input.select();
}

function rosterActions(row, section, redraw) {
  const fallback =
    section === "cloud" ? "Cloud agent" : section === "mcp" ? "Unnamed MCP client" : "Unnamed session";
  const name = rosterName(row, fallback);
  const more = el("button", {
    class: "btn more",
    text: "⋯",
    attrs: { "aria-label": `More actions for ${name}` },
  });
  const rename = el("button", { text: "Rename" });
  // This row menu never revokes a cloud credential: a live agent is deleted
  // from its detail panel (VM teardown), and a credential without a live
  // agent has nothing here to delete it with.
  const revoke = section === "cloud" ? null : el("button", { class: "danger", text: "Revoke" });
  const menu = el("div", { class: "more-menu", attrs: { role: "menu" } }, [rename, revoke]);
  menu.hidden = true;
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    for (const open of document.querySelectorAll(".more-menu:not([hidden])")) {
      if (open !== menu) open.hidden = true;
    }
    menu.hidden = !menu.hidden;
  });
  rename.addEventListener("click", () => {
    menu.hidden = true;
    openRosterRename(row, more, redraw, fallback);
  });
  revoke?.addEventListener("click", () => {
    menu.hidden = true;
    openRosterConfirm(row, more, redraw);
  });
  return [more, menu];
}

function cloudContext(agent, state) {
  const created = rosterDate(agent?.createdAt);
  return [
    cloudLine(agent, state),
    created ? `Created ${created}` : null,
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
      text: cloudContext(agent, state),
      attrs: { title: cloudContext(agent, state) },
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
  const retry = agent?.status === "failed" && agent.canRetry
    ? el("button", { class: "btn small", text: "Retry" })
    : null;
  const message = agent?.canMessage
    ? el("button", {
        class: "btn small message-btn",
        text: "Message",
        attrs: { "aria-label": `Message ${name}` },
      })
    : null;
  message?.addEventListener("click", () => window.domo.cloudOpenMessages(agent.agentId));
  retry?.addEventListener("click", async () => {
    retry.disabled = true;
    await window.domo.cloudRetryFailed(agent.agentId);
    await redraw();
  });
  const actions = [message, retry, ...(row ? rosterActions(row, "cloud", redraw) : [])].filter(Boolean);
  return el("div", { class: "entity-row cloud-agent-row", attrs: { "data-cloud-agent-id": agent?.agentId ?? row?.agentId ?? "" } }, [
    entityMark(name),
    main,
    actions.length ? el("div", { class: "entity-actions" }, actions) : null,
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
    el("div", { class: "entity-actions" }, rosterActions(row, section, redraw)),
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
  const rosterByAgentId = new Map(rosterRows.map((row) => [row.agentId, row]));
  const seen = new Set(agents.map((agent) => agent.agentId));
  const rows = agents.map((agent) =>
    cloudEntityRow(rosterByAgentId.get(agent.agentId), agent, s, redraw));
  const rosterOnly = rosterRows
    .filter((row) => !seen.has(row.agentId))
    .sort((a, b) => rosterName(a, "Cloud agent").localeCompare(rosterName(b, "Cloud agent")));
  for (const row of rosterOnly) {
    rows.push(cloudEntityRow(row, null, s, redraw));
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
  if (!s.rosterError && !s.actionError) return null;
  return el("div", { class: "roster-notices" }, [
    s.rosterError ? cloudErrorBanner(s.rosterError, "Sessions could not be refreshed") : null,
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
    connectorBox.replaceChildren(googleConnectorCard(connectorState, connectorActions));
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

  // Capabilities: what macOS lets the app itself reach. Full Disk Access has
  // no prompt an app can raise — the only grant path is in System Settings —
  // so the button starts main's grant flow (fdaGrantFlow), ported from
  // PermissionFlow (see permissionFlow.ts): the pane opens, a small floating
  // panel with the app as a native drag source follows the System Settings
  // window, and the status re-probes on a short interval so the grant lands
  // green without waiting for the boot()-installed focus refresh. The drag
  // source lives ONLY in that panel — a tile here would be a second copy of
  // the same gesture, in the window System Settings is about to cover.
  const capDot = el("span", { class: "status-dot" });
  const capStatus = el("span", { class: "faint", text: "…" });

  // While the flow runs, this card re-probes every 2s so its own dot flips
  // green in step with the floating panel main is running. Display only —
  // the flow's lifecycle (panel, tracker, timeout) lives in main's
  // fdaGrantFlow. Ends on grant, on leaving this tab (the tick sees
  // currentTab moved on), or after 3 minutes.
  let fdaGranted = false;
  let grantTicks = 0;
  let grantTimer = null;
  const stopGrantFlow = () => {
    if (grantTimer === null) return;
    clearInterval(grantTimer);
    grantTimer = null;
  };
  // The rest of the inventory (device-core's hostGate/inventory.ts): the
  // Automation consent per app the skills drive, and the app's own
  // self-checks. Rendered as one list under the Full Disk Access row, each
  // line a dot and a sentence, rebuilt from the snapshot on every read — the
  // renderer keeps nothing of its own.
  const inventoryList = el("div", { class: "inventory" });
  const inventoryRow = (on, title, detail) =>
    el("div", { class: "inventory-row" }, [
      el("span", { class: "status-dot" + (on === true ? " on" : on === null ? " unknown" : "") }),
      el("span", { class: "inventory-title", text: title }),
      el("span", { class: "faint", text: detail }),
    ]);
  const automationWords = {
    granted: "allowed",
    denied: "not allowed — System Settings > Privacy & Security > Automation",
    not_asked: "macOS will ask on the Mac's screen the first time",
    target_not_running: "unknown until that app is open",
    unknown: "cannot be checked in this build",
  };
  const applyInventory = (inv) => {
    inventoryList.replaceChildren();
    if (!inv) return;
    for (const a of inv.automation) {
      const on = a.status === "granted" ? true : a.status === "denied" ? false : null;
      inventoryList.appendChild(inventoryRow(on, `Control ${a.target}`, automationWords[a.status] ?? a.status));
    }
    inventoryList.appendChild(inventoryRow(
      inv.sandbox.status === "ok",
      "Command sandbox",
      inv.sandbox.status === "ok" ? "sandbox-exec runs" : `cannot run commands — ${inv.sandbox.detail ?? "unknown"}`,
    ));
    if (inv.child_attribution.status !== "not_applicable") {
      inventoryList.appendChild(inventoryRow(
        inv.child_attribution.status === "ok",
        "Commands inherit Full Disk Access",
        inv.child_attribution.status === "ok" ? "a command can read what the app can" : (inv.child_attribution.detail ?? "broken"),
      ));
    }
    if (inv.vault_key.status !== "absent") {
      inventoryList.appendChild(inventoryRow(
        inv.vault_key.status === "ok" ? true : inv.vault_key.status === "locked" ? false : null,
        "Browser vault key",
        inv.vault_key.status === "ok" ? "opens on this Mac" : (inv.vault_key.reason ?? inv.vault_key.status),
      ));
    }
  };
  const applyCapabilities = (caps) => {
    fdaGranted = caps.fullDiskAccess;
    capDot.className = "status-dot" + (caps.fullDiskAccess ? " on" : "");
    capStatus.textContent = caps.fullDiskAccess ? "Granted" : "Not granted";
    if (caps.fullDiskAccess) stopGrantFlow();
    applyInventory(caps.inventory ?? null);
  };
  const startGrantFlow = () => {
    if (grantTimer !== null || fdaGranted) return;
    grantTicks = 0;
    grantTimer = setInterval(async () => {
      if (currentTab !== "settings" || ++grantTicks > 90) return stopGrantFlow();
      applyCapabilities(await window.domo.capabilitiesGet());
    }, 2000);
  };
  applyCapabilities(await window.domo.capabilitiesGet());
  // Ellipsis, not ↗ (see extArrow): the click only starts this — the user
  // still has to grant over there, by dragging the app into the list or
  // flipping the switch. Main opens the pane and floats the helper panel.
  const openFullDisk = el("button", { class: "btn", text: "Open System Settings…" });
  openFullDisk.addEventListener("click", () => {
    window.domo.fullDiskGrantFlow();
    startGrantFlow();
  });

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
  const mounted = {
    applyConnectors,
    refresh: async () => {
      await refreshAccount();
      await refreshConnectors();
      applyCapabilities(await window.domo.capabilitiesGet());
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
    group("Connected accounts", null, [connectorBox, connectorNote]),
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
            "To grant it, click Open System Settings and drag the app from the panel that appears into the Full Disk Access list. " +
            "macOS may ask to quit and reopen the app." }),
        ]),
        el("div", { class: "spacer" }),
        openFullDisk,
      ]),
      inventoryList,
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
window.domo.onConnectorsChanged((state) => {
  if (currentTab === "settings") settingsMounted?.applyConnectors(state);
});
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
// Another app handed main a credential exchange (Apple Passwords' export):
// land on the Vault tab, whose render finds the staged preview and opens the
// Import sheet on it. Already there means re-render — selectTab dedupes and
// would leave the pane as it is — but never over unsaved edits: an open form
// gets its say first, exactly as a tab switch would give it.
window.domo.onVaultExchange(async () => {
  if (currentTab !== "vault") await selectTab("vault");
  else if (await vaultConfirmLeave()) render();
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
  // A credential exchange can arrive before this window exists (the system
  // launches the app for it); the push above then had no listener, so ask.
  // Only when landing elsewhere: a boot onto the Vault tab found it already.
  if (currentTab !== "vault" && (await window.domo.vaultExchangePending().catch(() => null))) {
    selectTab("vault");
  }
}
boot();
