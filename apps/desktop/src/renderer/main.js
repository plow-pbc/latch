/* Main-window renderer. Sandboxed: no Node, no ipcRenderer — only the narrow
   `window.domo` bridge from preload. All agent-derived text is inserted with
   textContent (never innerHTML), so nothing on the wire can inject markup. */

const view = document.getElementById("view");
const seg = document.getElementById("seg");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

let currentTab = "audit";
let filter = "all";
let selectedIndex = 0;

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
  statusText.textContent = status.connected
    ? `Connected · ${status.name}`
    : "Not connected";
}

// ---- Audit (master–detail, mockup Alternative 1) ----

async function renderAudit() {
  const rows = await window.domo.auditRows();
  const shown = rows.filter((r) => {
    if (filter === "all") return true;
    if (filter === "approved") return r.tone === "green";
    if (filter === "denied") return r.tone === "red" && r.status.includes("Denied");
    if (filter === "blocked") return r.status === "Blocked";
    return true;
  });
  if (selectedIndex >= shown.length) selectedIndex = 0;

  const toolbar = el("div", { class: "toolbar" }, [
    el("div", { class: "chips" }, ["all", "approved", "denied", "blocked"].map((f) => {
      const chip = el("span", { class: "chip" + (filter === f ? " active" : ""), text: f[0].toUpperCase() + f.slice(1) });
      chip.addEventListener("click", () => { filter = f; selectedIndex = 0; renderAudit(); });
      return chip;
    })),
    el("div", { class: "spacer" }),
    el("span", { class: "count", text: `${shown.length} activities` }),
  ]);

  const tbody = el("tbody");
  shown.forEach((r, i) => {
    const tr = el("tr", { class: i === selectedIndex ? "sel" : "" }, [
      el("td", { class: "t-time", text: r.time }),
      el("td", {}, [badge(r.tone, r.status)]),
      el("td", {}, [el("div", { class: "t-act" }, [
        el("span", { class: "ic-wrap" }, [icon(r.kind)]),
        el("span", { class: r.kind === "command" || r.kind === "file" ? "mono" : "", text: r.activity }),
      ])]),
    ]);
    tr.addEventListener("click", () => { selectedIndex = i; renderAudit(); });
    tbody.appendChild(tr);
  });

  const table = el("table", {}, [
    el("thead", {}, [el("tr", {}, [
      el("th", { text: "Time" }), el("th", { text: "Status" }), el("th", { text: "Activity" }),
    ])]),
    tbody,
  ]);
  const list = el("div", { class: "list" }, [shown.length ? table : el("div", { class: "empty", text: "No activity yet." })]);

  const detail = el("aside", { class: "detail" }, [detailFor(shown[selectedIndex])]);
  view.replaceChildren(toolbar, el("div", { class: "a1" }, [list, detail]));
}

function detailFor(row) {
  if (!row) return el("div", { class: "empty", text: "Select an activity." });
  const raw = row.raw || {};
  const meta = el("dl", { class: "meta" });
  const addMeta = (k, v, mono) => {
    meta.appendChild(el("dt", { text: k }));
    meta.appendChild(el("dd", { class: mono ? "mono faint" : "", text: v }));
  };
  if (raw.agent) addMeta("Agent", String(raw.agent), true);
  if (raw.intentId) addMeta("Intent", String(raw.intentId), true);
  if (raw.goal) addMeta("Goal", String(raw.goal));
  if (raw.exit_code !== undefined) addMeta("Exit", String(raw.exit_code));
  if (raw.reason) addMeta("Reason", String(raw.reason));
  if (raw.path) addMeta("Path", String(raw.path), true);

  const children = [
    el("h3", {}, [badge(row.tone, row.status)]),
    el("div", { class: "cmd", text: row.activity }),
    meta,
  ];
  if (Array.isArray(raw.capabilities)) {
    children.push(el("div", { class: "section-label", text: "Approved capability bounds" }));
    children.push(el("div", { class: "capchips" }, raw.capabilities.map((c) => el("span", { class: "cap", text: String(c) }))));
  }
  return el("div", {}, children);
}

// ---- Goals ----

// Only shown on FAILURE — a successful Start agent opens a Terminal, which is
// where all interaction and status happen, so there's nothing to report here.
let goalsError = "";

async function startAgentFor(goalText) {
  if (!goalText.trim()) { goalsError = "Type or pick a goal first."; renderGoals(); return; }
  goalsError = "";
  const result = await window.domo.goalsStartAgent(goalText);
  goalsError = result.ok ? "" : result.message;
  renderGoals();
}

async function renderGoals() {
  const goals = await window.domo.goalsList();
  const titleInput = el("input", { class: "text", attrs: { placeholder: "Goal title" } });
  const textInput = el("textarea", { class: "text", attrs: { placeholder: "What should the agent do?" } });
  const addBtn = el("button", { class: "btn", text: "Add goal" });
  addBtn.addEventListener("click", async () => {
    if (!titleInput.value.trim()) return;
    await window.domo.goalsAdd(titleInput.value.trim(), textInput.value.trim());
    renderGoals();
  });
  const startNew = el("button", { class: "btn primary", text: "Start Agent" });
  startNew.addEventListener("click", () => startAgentFor(textInput.value));

  const items = goals.map((g) => {
    const start = el("button", { class: "btn primary", text: "Start Agent" });
    start.addEventListener("click", () => startAgentFor(g.text));

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

    const header = el("div", { class: "row" }, [
      el("h4", { text: g.title }),
      el("div", { class: "spacer" }),
      el("div", { class: "menu-wrap" }, [menuBtn, menu]),
    ]);
    const actions = el("div", { class: "row" }, [el("div", { class: "spacer" }), start]);
    return el("div", { class: "item" }, [header, el("p", { text: g.text }), actions]);
  });

  const children = [
    el("div", { class: "item" }, [
      el("div", { class: "field" }, [el("label", { text: "New goal" }), titleInput]),
      el("div", { class: "field" }, [textInput]),
      el("div", { class: "row" }, [el("div", { class: "spacer" }), addBtn, startNew]),
    ]),
  ];
  if (goalsError) {
    children.push(el("div", { class: "item" }, [el("pre", { class: "agent-status", text: goalsError })]));
  }
  children.push(...items);
  view.replaceChildren(el("div", { class: "panel" }, children));
}

// ---- Rules + pinned agents ----

async function renderRules() {
  const rules = await window.domo.rulesList();
  const agents = await window.domo.agentsList();

  const ruleItems = rules.length
    ? rules.map((r) => {
        const remove = el("button", { class: "btn danger", text: "Revoke rule" });
        remove.addEventListener("click", async () => { await window.domo.rulesRemove(r.ruleKey); renderRules(); });
        const caps = (r.capabilities || []).map((c) => el("span", { class: "cap", text: capText(c) }));
        return el("div", { class: "item" }, [
          el("div", { class: "row" }, [el("h4", { text: r.agentDisplay || r.agentId }), el("div", { class: "spacer" }), remove]),
          el("div", { class: "capchips" }, caps),
        ]);
      })
    : [el("div", { class: "empty", text: "No always-allow rules." })];

  const agentItems = agents.length
    ? agents.map((id) => {
        const revoke = el("button", { class: "btn danger", text: "Revoke agent" });
        revoke.addEventListener("click", async () => { await window.domo.agentsRevoke(id); renderRules(); });
        return el("div", { class: "item" }, [el("div", { class: "row" }, [
          el("span", { class: "mono", text: id }), el("div", { class: "spacer" }), revoke,
        ])]);
      })
    : [el("div", { class: "empty", text: "No agents pinned." })];

  view.replaceChildren(el("div", { class: "panel" }, [
    el("div", { class: "section-label", text: "Always-allow rules" }),
    ...ruleItems,
    el("div", { class: "section-label", text: "Trusted agents" }),
    ...agentItems,
  ]));
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
  const settings = await window.domo.settingsGet();
  const input = el("input", { class: "text", attrs: { placeholder: "domo1.… or wss://broker:port/" } });
  input.value = settings.brokerConnection || "";
  const save = el("button", { class: "btn primary", text: "Save & reconnect" });
  const note = el("p", { class: "faint", text: "" });
  save.addEventListener("click", async () => {
    await window.domo.settingsSet(input.value.trim());
    note.textContent = "Saved. Reconnecting…";
    refreshStatus();
  });
  const restoreNote = el("p", { class: "faint", text: "" });
  const restore = el("button", { class: "btn", text: "Restore default goals" });
  restore.addEventListener("click", async () => {
    await window.domo.goalsRestoreDefaults();
    restoreNote.textContent = "Default goals restored.";
  });

  view.replaceChildren(el("div", { class: "panel" }, [
    el("div", { class: "item" }, [
      el("div", { class: "field" }, [
        el("label", { text: "Broker connection string" }),
        input,
      ]),
      el("div", { class: "row" }, [note, el("div", { class: "spacer" }), save]),
    ]),
    el("div", { class: "item" }, [
      el("div", { class: "field" }, [
        el("label", { text: "Goals" }),
        el("p", { class: "faint", text: "Re-add any default goals you've removed." }),
      ]),
      el("div", { class: "row" }, [restoreNote, el("div", { class: "spacer" }), restore]),
    ]),
  ]));
}

function render() {
  if (currentTab === "audit") renderAudit();
  else if (currentTab === "goals") renderGoals();
  else if (currentTab === "rules") renderRules();
  else if (currentTab === "settings") renderSettings();
}

seg.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  currentTab = btn.dataset.tab;
  for (const b of seg.querySelectorAll("button")) b.classList.toggle("active", b === btn);
  render();
});

window.domo.onAuditChanged(() => { if (currentTab === "audit") renderAudit(); });
window.domo.onStatusChanged(() => refreshStatus());

refreshStatus();
render();
