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
  const detailBox = el("aside", { class: "detail" });
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

  auditMounted = { listBox, detailBox, count, chipsBox, clearBtn, table, tbody, rows: new Map() };
  await refreshAudit();
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
  const { listBox, detailBox, count, chipsBox, clearBtn, table, tbody, rows } = auditMounted;
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
    detailBox.replaceChildren(detailFor(selected));
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

  detailBox.replaceChildren(detailFor(selected));

  // Rows are in the DOM now (natural size measurable) — play the insert
  // animation for any freshly arrived rows.
  enterRows.forEach(animateRowEnter);
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
    default: return c.kind;
  }
}

// ---- Settings ----

async function renderSettings() {
  // The Plow account. There is no credential field and no URL field here: the
  // credential is minted by first-run login and never leaves the main process,
  // and the API origin is baked into the build (a token is only valid against
  // the environment that minted it, so an editable origin could only be wrong).
  const relayNote = el("p", { class: "faint", text: "" });
  const setUp = el("button", { class: "btn primary", text: "Sign In" });
  setUp.addEventListener("click", () => window.domo.onboardingOpen());
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
    setUp.textContent = relay.hasCredential ? "Create Agent" : "Sign In";
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

  // Build one settings group: a prominent title, an optional description, then
  // the group's body nodes.
  const group = (title, desc, body) =>
    el("div", { class: "item" }, [
      el("div", { class: "group-title", text: title }),
      desc ? el("p", { class: "faint group-desc", text: desc }) : null,
      ...body,
    ]);

  view.replaceChildren(el("div", { class: "panel settings" }, [
    group("Plow account", "Sign in with your phone number to let agents reach this Mac.", [
      accountBox,
      el("div", { class: "row" }, [relayNote, el("div", { class: "spacer" }), signOut, setUp]),
    ]),
    group("Reviewer inference", "The provider you pick judges each operation, so it receives the command being reviewed, the paths it asks for, and that agent's recent activity on this Mac. It bills that account; nothing from other agents is sent.", [
      providerChips,
      reviewerNote,
    ]),
    group("Anthropic API key", "Only needed to run the reviewer on your own Anthropic account. Stored locally.", [
      apiKeyInput,
    ]),
    group("Approval mode", "How operations are decided.", [
      modeChips,
      suggestLabel,
    ]),
    group("Goals", "Re-add any default goals you've removed.", [
      el("div", { class: "row" }, [restore, restoreNote]),
    ]),
  ]));
}

function render() {
  if (currentTab === "audit") renderAudit();
  else if (currentTab === "goals") renderGoals();
  else if (currentTab === "rules") renderRules();
  else if (currentTab === "settings") renderSettings();
}

function selectTab(tab) {
  currentTab = tab;
  if (tab !== "audit") auditMounted = null; // avoid stale refreshes into detached nodes
  if (tab !== "settings") settingsMounted = null;
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
});

// Restore the last-selected tab (falls back to the HTML default on any miss).
async function boot() {
  refreshStatus();
  const saved = await window.domo.uiGetTab();
  const known = ["goals", "audit", "rules", "settings"];
  selectTab(known.includes(saved) ? saved : "audit");
}
boot();
