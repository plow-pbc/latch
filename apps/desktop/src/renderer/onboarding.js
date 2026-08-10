/* First-run login renderer — phone → code → connected, plus the create-agent
   result. Sandboxed like every other window: no Node, no ipcRenderer, only the
   narrow `window.domo` bridge, and every string inserted with textContent.

   The main process owns the state machine; each call here returns the whole
   state and this file just draws it. There is no local copy to drift. */

const root = document.getElementById("root");

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

function button(text, cls, onClick) {
  const b = el("button", { class: cls, text });
  b.addEventListener("click", onClick);
  return b;
}

/** A read-only value with a Copy button — the only way a credential or an
    endpoint leaves this window. */
function copyRow(value, label) {
  const box = el("div", { class: "copybox mono", text: value });
  const copy = button(label ?? "Copy", "btn small", async () => {
    await navigator.clipboard.writeText(value);
    copy.textContent = "Copied";
    setTimeout(() => { copy.textContent = label ?? "Copy"; }, 1200);
  });
  return el("div", { class: "copyrow" }, [box, copy]);
}

/** The one honest line at the bottom of every screen. Never a bare spinner:
    when we are waiting we say what for, and when we fail we say what failed. */
function note(state) {
  if (state.busy) return el("p", { class: "faint", text: "Talking to Plow…" });
  if (!state.message) return null;
  return el("p", { class: "faint onote", text: state.message });
}

let state = null;

async function apply(next) {
  if (next) state = next;
  render();
}

// MARK: screens

function phoneScreen() {
  const input = el("input", { class: "text", attrs: { type: "tel", placeholder: "+1 555 123 4567", autofocus: "" } });
  input.value = state.phone || "";
  const submit = async () => apply(await window.domo.onboardingRequestCode(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  return [
    el("h2", { text: "Sign in to Plow" }),
    el("p", { class: "faint lede", text: "Enter the phone number on your Plow account. We'll text you a code." }),
    el("div", { class: "field" }, [el("label", { text: "Phone number" }), input]),
    el("div", { class: "oactions" }, [
      el("div", { class: "spacer" }),
      button("Send Code", "btn primary", submit),
    ]),
    note(state),
  ];
}

function codeScreen() {
  const input = el("input", {
    class: "text mono",
    attrs: { inputmode: "numeric", maxlength: "8", placeholder: "12345678", autofocus: "" },
  });
  const submit = async () => apply(await window.domo.onboardingSubmitCode(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  const expiry = el("span", { class: "faint" });
  const tick = () => {
    if (!state.codeExpiresAt) { expiry.textContent = ""; return; }
    const left = Math.max(0, state.codeExpiresAt - Date.now());
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    expiry.textContent = left > 0
      ? `Expires in ${m}:${String(s).padStart(2, "0")}`
      : "This code has expired.";
  };
  tick();
  clearInterval(window.__domoExpiryTimer);
  window.__domoExpiryTimer = setInterval(tick, 1000);

  return [
    el("h2", { text: "Check your phone" }),
    // Deliberate wording: /otp/request answers the same for an unknown number,
    // an unparseable number and a failed send, so the app genuinely cannot know
    // a code went out. Claiming "we've sent you a code" would be a lie we can't
    // back up.
    el("p", { class: "faint lede", text: `If ${state.phone} is on a Plow account, an 8-digit code is on its way.` }),
    el("div", { class: "field" }, [el("label", { text: "Code" }), input]),
    el("div", { class: "orow" }, [expiry]),
    el("div", { class: "oactions" }, [
      button("Change Number", "btn small", async () => apply(await window.domo.onboardingEditPhone())),
      button("Resend", "btn small", async () => apply(await window.domo.onboardingResendCode())),
      el("div", { class: "spacer" }),
      button("Sign In", "btn primary", submit),
    ]),
    note(state),
  ];
}

function connectedScreen() {
  const nameInput = el("input", { class: "text", attrs: { placeholder: "Claude Code" } });
  const create = async () => apply(await window.domo.onboardingCreateAgent(nameInput.value));
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });

  return [
    el("div", { class: "orow" }, [
      el("span", { class: `status-dot${state.connected ? " on" : ""}` }),
      el("h2", { text: state.connected ? "This Mac is connected" : "Signed in — connecting…" }),
    ]),
    el("p", { class: "faint lede", text: "Agents reach this Mac at the endpoint below. Give each agent its own credential." }),
    el("div", { class: "field" }, [
      el("label", { text: "Agent endpoint" }),
      copyRow(state.mcpUrl || "—"),
    ]),
    el("div", { class: "field" }, [
      el("label", { text: "Account" }),
      el("div", { class: "faint mono", text: state.accountUid || "—" }),
    ]),
    el("div", { class: "field" }, [el("label", { text: "New agent name" }), nameInput]),
    el("div", { class: "oactions" }, [
      button("Done", "btn", () => window.domo.onboardingFinish()),
      el("div", { class: "spacer" }),
      button("Create Agent", "btn primary", create),
    ]),
    note(state),
  ];
}

function agentScreen() {
  const agent = state.agent;
  return [
    el("h2", { text: `Credential for ${agent.name}` }),
    el("p", { class: "warn lede", text: "Copy this now — it is shown once and cannot be shown again." }),
    el("div", { class: "field" }, [
      el("label", { text: "MCP client config" }),
      copyRow(agent.config, "Copy Config"),
    ]),
    el("div", { class: "oactions" }, [
      el("div", { class: "spacer" }),
      button("I've Saved It", "btn primary", async () => apply(await window.domo.onboardingDismissAgent())),
    ]),
    note(state),
  ];
}

function render() {
  if (!state) return;
  const screen =
    state.step === "phone" ? phoneScreen()
    : state.step === "code" ? codeScreen()
    : state.step === "agent" ? agentScreen()
    : connectedScreen();
  root.replaceChildren(...screen.filter(Boolean));
  const focus = root.querySelector("input[autofocus]");
  if (focus && !state.busy) focus.focus();
  for (const b of root.querySelectorAll("button")) b.disabled = !!state.busy;
}

window.domo.onOnboardingChanged(async () => apply(await window.domo.onboardingGet()));

(async () => apply(await window.domo.onboardingGet()))();
