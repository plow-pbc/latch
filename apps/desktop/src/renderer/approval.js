/* Approval-window renderer — the consent surface. It renders ONLY the view
   model the main process derived from the VERIFIED canonical intent, and it
   inserts every agent-derived string with textContent, never innerHTML. The
   enforceable "fine print" is the capability set (what the sandbox is built
   from); the goal/request are shown as unverifiable context. */

const root = document.getElementById("root");

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  for (const c of children) if (c) node.appendChild(c);
  return node;
}
function badge(tone, text) {
  return el("span", { class: `badge b-${tone}` }, [el("span", { class: "dot" }), el("span", { text })]);
}

function decide(id, decision) {
  window.domo.approvalDecide(id, decision);
}

async function render() {
  const req = await window.domo.approvalGet();

  if (req.kind === "access") {
    root.replaceChildren(
      el("div", { class: "who" }, [el("span", { class: "name", text: req.agentDisplay })]),
      el("div", { class: "faint mono", text: req.agentId }),
      el("div", { class: "goal", text: "wants access to this Mac" }),
      el("div", { class: "fine" }, [
        el("div", { class: "lbl", text: "Stated goals (unverified)" }),
        el("div", { text: req.goals || "—" }),
      ]),
      el("div", { class: "actions" }, [
        button("Deny", "btn", () => decide(`access:${req.agentId}`, "deny")),
        button("Allow", "btn primary", () => decide(`access:${req.agentId}`, "allow_once")),
      ]),
    );
    return;
  }

  const v = req.view;
  const capchips = el("div", { class: "capchips" }, v.capabilities.map((c) => el("span", { class: "cap", text: c.display })));
  const warnings = [];
  if (v.runsCommand) warnings.push("runs a command");
  if (v.writesFiles) warnings.push("writes files");
  if (v.needsNetwork) warnings.push("uses the network");

  root.replaceChildren(
    el("div", { class: "who" }, [
      el("span", { class: "name", text: v.agentDisplay }),
      badge("blue", "wants to act"),
    ]),
    el("div", { class: "faint mono", text: v.agentId }),
    el("div", { class: "goal", text: v.goal || v.request }),
    el("div", { class: "fine" }, [
      el("div", { class: "lbl", text: "This will be allowed to (enforced)" }),
      capchips,
      warnings.length
        ? el("div", { class: "warn", text: "⚠ " + warnings.join(" · ") })
        : null,
      v.planContext ? el("div", { class: "lbl", text: "Session context" }) : null,
      v.planContext ? el("div", { class: "faint", text: v.planContext }) : null,
    ]),
    el("div", { class: "actions" }, [
      button("Deny", "btn danger", () => decide(v.intentId, "deny")),
      button("Allow once", "btn", () => decide(v.intentId, "allow_once")),
      button("Always allow", "btn primary", () => decide(v.intentId, "always_allow")),
    ]),
  );
}

function button(label, cls, onClick) {
  const b = el("button", { class: cls, text: label });
  b.addEventListener("click", onClick);
  return b;
}

render();
