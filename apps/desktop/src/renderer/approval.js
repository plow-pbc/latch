/* Approval-window renderer — the consent surface. It renders ONLY the view
   model the main process derived from the VERIFIED canonical intent, and it
   inserts every agent-derived string with textContent, never innerHTML. The
   enforceable "fine print" is the capability set (what the sandbox is built
   from); the goal/request are shown as unverifiable context. */

import { continuationView, secondsLeft } from "./continuationView.js";

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

  /* The continuation strip: where this approval's operation stands, and how
     much of the originating call is left. It sits ABOVE the capability card
     because it is about the call, not about what is being allowed — nothing
     here may read as part of the enforced bound. */
  const strip = el("div", { class: "continuation" });
  let phase = req.continuation?.state ?? null;
  const deadlineAt = req.continuation?.deadlineAt ?? null;
  /* Recorded separately from the state, because it IS separate: the relay
     never confirming the handoff says nothing about what became of the work. */
  let deliveryUnknown = req.continuation?.deliveryUnknown === true;
  let decided = false;

  const copyButton = button("Copy phrase", "btn small", () => {
    window.domo.approvalCopyPhrase();
    copyButton.textContent = "Copied";
  });
  const dismissButton = button("Dismiss", "btn small", () => {
    window.domo.approvalDismiss(v.intentId);
  });

  function paintContinuation() {
    const view = continuationView({
      state: phase,
      deadlineAt,
      now: Date.now(),
      decided,
      deliveryUnknown,
    });
    if (view.headline === null) {
      strip.replaceChildren();
      strip.classList.remove("shown");
      return;
    }
    strip.classList.add("shown");
    strip.classList.toggle("confirming", view.confirmation);
    const line = [el("div", { class: "cont-headline", text: view.headline })];
    if (view.detail) line.push(el("div", { class: "cont-detail", text: view.detail }));
    /* The countdown is a PREDICTION about the call's deadline and is labelled
       as one. It never moves the window between states: those arrive as
       recorded changes from main. */
    if (view.remainingMs !== null) {
      line.push(
        el("div", { class: "cont-countdown", text: `~${secondsLeft(view.remainingMs)}s left` }),
      );
    }
    const actions = [];
    if (view.showCopy) actions.push(copyButton);
    if (view.confirmation) actions.push(dismissButton);
    if (actions.length) line.push(el("div", { class: "cont-actions" }, actions));
    strip.replaceChildren(...line);
  }

  /* Recorded changes only. */
  window.domo.onApprovalContinuation((data) => {
    if (data.intentId !== v.intentId) return;
    phase = data.state;
    if (data.deliveryUnknown === true) deliveryUnknown = true;
    paintContinuation();
    if (decided) collapseToConfirmation();
  });
  window.domo.onApprovalDecided((data) => {
    if (data.intentId !== v.intentId) return;
    decided = true;
    collapseToConfirmation();
  });

  /* Once the decision is in and the call has already been handed off, the
     window stops being a question and becomes a short answer: what happens
     next, and the phrase that makes it happen. */
  function collapseToConfirmation() {
    paintContinuation();
    root.replaceChildren(
      el("div", { class: "who" }, [el("span", { class: "name", text: v.agentDisplay })]),
      strip,
    );
  }

  /* Redraw the countdown on its own interval. It re-reads the clock; it never
     invents a state change. */
  const tick = setInterval(paintContinuation, 1000);
  window.addEventListener("beforeunload", () => clearInterval(tick));
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
    strip,
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
  paintContinuation();
  allowOnce.focus(); // keyboard default: Return activates Allow Once

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
        el("span", { class: "lbl", text: "Adversarial agent (advice only)" }),
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
  b.addEventListener("click", onClick);
  return b;
}

render();
