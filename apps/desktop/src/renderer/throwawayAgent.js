/*
 * THROWAWAY. Delete this file when GET /v1/agents/cloud and chats:use deploy.
 * The real cloud-agent roster and chat picker replace this single persisted-chat
 * card; it exists only so POST and DELETE can be used against production today.
 */
import { el } from "./dom.js";

function detail(label, value, mono = false) {
  return el("div", { class: "throwaway-detail" }, [
    el("div", { class: "throwaway-label", text: label }),
    el("div", { class: mono ? "throwaway-value mono" : "throwaway-value", text: value || "—" }),
  ]);
}

function createdAt(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? (value || "—") : date.toLocaleString();
}

function workingButton(button, label) {
  button.disabled = true;
  button.replaceChildren(
    el("span", { class: "cloud-spinner", attrs: { "aria-hidden": "true" } }),
    el("span", { text: label }),
  );
}

async function run(button, label, action, redraw) {
  workingButton(button, label);
  try {
    await action();
  } finally {
    await redraw();
  }
}

/** Render the temporary one-agent lifecycle from the main process's state. */
export function throwawayAgentNodes(state, { create, remove, redraw }) {
  if (!state) return [];

  const details = el("div", { class: "throwaway-details" }, [
    detail("Chat", state.chatLabel || state.chatUid),
    detail("Phone number", state.sendTo, true),
    detail("Raw API log", state.logPath, true),
  ]);
  const capabilities = el("div", { class: "throwaway-capabilities" }, [
    el("div", { class: "throwaway-label", text: "What it can do" }),
    el("ul", {}, (state.capabilities ?? []).map((text) => el("li", { text }))),
  ]);
  const error = state.error
    ? el("div", { class: "cloud-callout cloud-error throwaway-error" }, [
        el("div", { class: "cloud-callout-title", text: "Plow could not finish that request" }),
        // Server detail is human-authored. Keep it verbatim, but only as text.
        el("p", { text: state.error }),
      ])
    : null;

  if (!state.agent) {
    const get = el("button", {
      class: "btn primary",
      text: "Get an agent",
      attrs: { type: "button" },
    });
    get.disabled = state.busy || !state.ready;
    if (state.busy) workingButton(get, "Getting an agent…");
    get.addEventListener("click", () => run(get, "Getting an agent…", create, redraw));
    return [details, capabilities, error, el("div", { class: "row throwaway-actions" }, [get])].filter(Boolean);
  }

  const removeButton = el("button", {
    class: "btn danger",
    text: "Delete",
    attrs: { type: "button" },
  });
  removeButton.disabled = state.busy;
  if (state.busy) workingButton(removeButton, "Deleting…");
  removeButton.addEventListener("click", () => run(removeButton, "Deleting…", remove, redraw));
  const agent = el("div", { class: "item cloud-agent-row throwaway-agent" }, [
    detail("Agent id", state.agent.agentId, true),
    detail("Provider", state.agent.provider),
    detail("Created", createdAt(state.agent.createdAt)),
    el("div", { class: "row throwaway-actions" }, [removeButton]),
  ]);
  return [details, capabilities, error, agent].filter(Boolean);
}
