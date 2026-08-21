/* Approval-window renderer — the consent surface. It renders ONLY the view
   model the main process derived from the VERIFIED canonical intent, and it
   inserts every agent-derived string with textContent, never innerHTML. The
   enforceable "fine print" is the capability set (what the sandbox is built
   from); the goal/request are shown as unverifiable context. */

import { InputArming } from "./arming.js";

const root = document.getElementById("root");

// The window may take key focus while the human is typing elsewhere, so input
// only counts once the window has been quietly focused for a moment AND the
// press began after that (see arming.js). Press starts are recorded at capture
// phase so they're seen before any click handler consults mayActivate().
const arming = new InputArming({ now: () => performance.now() });
window.addEventListener("keydown", (e) => arming.pressStarted("key", { repeat: e.repeat }), true);
window.addEventListener("mousedown", () => arming.pressStarted("mouse"), true);

/* Disable the action buttons until the mouse arming delay elapses. Arming is
   ONE-SHOT, at show: an agent is actively driving this Mac, so window focus
   shifts under the user constantly — re-arming on focus made the buttons fade
   out and revoke themselves mid-read. Once enabled they stay enabled; the
   press-start rule in arming.js still rejects input that began elsewhere.
   Keyboard arms later than mouse, so `focusTarget` only gets keyboard focus
   at that later moment; until then a stray Return has nothing to land on, and
   the gate in button() covers the rest. */
function armActions(buttons, focusTarget) {
  const setEnabled = (on) => buttons.forEach((b) => (b.disabled = !on));
  arming.arm();
  setEnabled(false);
  setTimeout(() => setEnabled(true), arming.remainingMs("mouse"));
  // The default focus must YIELD: buttons are Tab-focusable from the moment
  // they enable, and stealing focus from a button the human already chose
  // (Deny, say) would aim their next armed Return at Allow Once instead —
  // the exact accident this file exists to prevent. Renderer-only wiring no
  // vitest case can pin, so don't "simplify" the guard away.
  setTimeout(() => {
    if (!buttons.includes(document.activeElement)) focusTarget.focus();
  }, arming.remainingMs("key"));
}

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
    const deny = button("Deny", "btn", () => decide(`access:${req.agentId}`, "deny"));
    const allow = button("Allow", "btn primary", () => decide(`access:${req.agentId}`, "allow_once"));
    root.replaceChildren(
      el("div", { class: "who" }, [el("span", { class: "name", text: req.agentDisplay })]),
      el("div", { class: "faint mono", text: req.agentId }),
      el("div", { class: "goal", text: "wants access to this Mac" }),
      el("div", { class: "fine" }, [
        el("div", { class: "lbl", text: "Stated goals (unverified)" }),
        el("div", { text: req.goals || "—" }),
      ]),
      el("div", { class: "actions" }, [deny, allow]),
    );
    armActions([deny, allow], allow);
    return;
  }

  const v = req.view;
  const capchips = el("div", { class: "capchips" }, v.capabilities.map((c) => el("span", { class: "cap", text: c.display })));
  const warnings = [];
  if (v.runsCommand) warnings.push("runs a command");
  if (v.writesFiles) warnings.push("writes files");
  if (v.needsNetwork) warnings.push("uses the network");
  if (v.usesBrowser) warnings.push("browses the web as you");
  if (v.fillsCredentials) warnings.push("types saved credentials into those sites");

  // "Allow Once" is the default (primary, rightmost, focused); "Always Allow"
  // is the more permissive option and sits in the middle.
  const deny = button("Deny", "btn danger", () => decide(v.intentId, "deny"));
  const alwaysAllow = button("Always Allow", "btn", () => decide(v.intentId, "always_allow"));
  const allowOnce = button("Allow Once", "btn primary", () => decide(v.intentId, "allow_once"));
  // Each button lives in a slot; the agent-suggestion glow goes on the slot
  // (behind the button) so its blur isn't clipped.
  const denySlot = el("div", { class: "action-slot" }, [deny]);
  const alwaysSlot = el("div", { class: "action-slot" }, [alwaysAllow]);
  const allowSlot = el("div", { class: "action-slot" }, [allowOnce]);
  const slotByDecision = { deny: denySlot, always_allow: alwaysSlot, allow_once: allowSlot };

  // A tiny rainbow spinner pinned to the window's bottom-right corner, shown
  // while an adversarial review is in flight (Ask mode + suggestions on).
  // Cleared when the verdict lands.
  const reviewing = req.suggesting
    ? el("div", { class: "reviewing-spinner" })
    : null;

  // Filled in when the reviewer answers. Empty until then, so the window never
  // reserves space for advice that may never arrive.
  const reviewerNote = el("div", { class: "reviewer-note" });

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
    reviewerNote,
    el("div", { class: "actions" }, [denySlot, alwaysSlot, allowSlot]),
  );
  if (reviewing) document.body.appendChild(reviewing);
  // Keyboard default: Return activates Allow Once — but only once armed.
  armActions([deny, alwaysAllow, allowOnce], allowOnce);

  // When the adversarial agent responds, clear the indicator and (if it made a
  // recommendation) highlight the button it suggests. A null decision means it
  // deferred to you — indicator clears, nothing highlighted.
  window.domo.onApprovalSuggestion((data) => {
    if (data.id !== v.intentId) return;
    if (reviewing) reviewing.remove();
    const target = data.decision ? slotByDecision[data.decision] : null;
    if (target) target.classList.add("suggested");
    // What the reviewer said, in its own words — including when it could not
    // answer at all, which is when a prompt otherwise arrives unexplained.
    //
    // Display-only and inserted as textContent: it sits OUTSIDE the "will be
    // allowed to (enforced)" block on purpose, because the enforceable bound is
    // the capability set and nothing written here may look like part of it.
    if (data.reason) {
      reviewerNote.replaceChildren(
        el("span", { class: "lbl", text: "AI Reviewer (advice only)" }),
        el("span", { text: data.reason }),
      );
    }
  });

  // Listener installed — tell main, which has been holding anything the
  // reviewer already said.
  window.domo.approvalReady();
}

function button(label, cls, onClick) {
  const b = el("button", { class: cls, text: label });
  // Every action goes through the arming gate: the disabled attribute blocks
  // clicks before the delay, but only the gate knows whether the press that
  // produced this click STARTED after arming (keydown/mousedown time, not
  // click time — see arming.js).
  b.addEventListener("click", () => {
    if (arming.mayActivate()) onClick();
  });
  return b;
}

render();
