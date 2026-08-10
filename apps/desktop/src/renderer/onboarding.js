/* First-run setup renderer — show a code → the user texts it → connected, plus
   the create-agent result, and the phone-code fallback behind a quiet link.
   Sandboxed like every other window: no Node, no ipcRenderer, only the narrow
   `window.domo` bridge, and every string inserted with textContent.

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
  // `local`: this button touches the clipboard and nothing else, so it is not
  // disabled while a request is in flight. Copying your own endpoint has no
  // bearing on a call to Plow, and a request that stalls should never take the
  // whole window with it.
  const copy = button(label ?? "Copy", "btn small local", async () => {
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

/** A quiet way out to the phone-code path, on both activation screens. It is
    the fallback for a Mac with no Messages account signed in, and for signing
    in as one specific account rather than as whoever texts. */
function phoneCodeLink() {
  return el("div", { class: "orow" }, [
    button("Use a phone code instead", "linkbtn", async () =>
      apply(await window.domo.onboardingUsePhoneCode()),
    ),
  ]);
}

/** The exact message body, and who to send it to. Shown on both activation
    screens because a wrong prefix is answered with total silence on both
    channels — the server returns 200, sends nothing, and leaves the code live.
    So the user is given the text to copy, never a description of it. */
function sendInstructions(activation) {
  return [
    el("div", { class: "field" }, [
      el("label", { text: "Send this exact message" }),
      copyRow(activation.smsBody, "Copy"),
    ]),
    el("div", { class: "field" }, [
      el("label", { text: "To" }),
      // Whatever /v1/auth/activate returned. Per-environment config, and it may
      // be a pool line rather than the managed number — never hardcoded.
      el("div", { class: "faint mono", text: activation.sendTo }),
    ]),
  ];
}

/** Minutes:seconds left of the window we watch for, or "" once it is up. */
function countdown(node, until) {
  const tick = () => {
    const left = Math.max(0, until - Date.now());
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    node.textContent = left > 0 ? `Listening for ${m}:${String(s).padStart(2, "0")}` : "";
  };
  tick();
  clearInterval(window.__domoExpiryTimer);
  window.__domoExpiryTimer = setInterval(tick, 1000);
}

function activateScreen() {
  const activation = state.activation;
  if (!activation) {
    return [
      el("h2", { text: "Connect this Mac" }),
      el("p", { class: "faint lede", text: "Getting a code from Plow…" }),
      note(state),
    ];
  }

  return [
    el("h2", { text: "Connect this Mac" }),
    el("p", {
      class: "faint lede",
      text: "Text this code to Plow from the phone you want on the account. Plow creates the account from that text — there's nothing to type here.",
    }),
    el("div", { class: "bigcode mono", text: activation.displayCode }),
    // Said in the same breath as showing it: whoever texts this code gets the
    // account, and the server cannot tell them apart from the person holding
    // this Mac.
    el("p", {
      class: "warn lede",
      text: "This code is a credential. Anyone who texts it gets the account — don't share it or post a screenshot.",
    }),
    ...sendInstructions(activation),
    el("div", { class: "oactions" }, [
      button("Open Messages", "btn primary", async () =>
        apply(await window.domo.onboardingOpenMessages()),
      ),
    ]),
    phoneCodeLink(),
    note(state),
  ];
}

function waitingScreen() {
  const activation = state.activation;
  const clock = el("span", { class: "faint" });
  if (activation && !state.activationStale) countdown(clock, activation.pollUntil);
  else clearInterval(window.__domoExpiryTimer);

  return [
    el("div", { class: "orow" }, [
      el("span", { class: `status-dot${state.activationStale ? "" : " on"}` }),
      el("h2", { text: state.activationStale ? "Still nothing" : "Waiting for your text" }),
    ]),
    el("p", {
      class: "faint lede",
      text: state.activationStale
        ? "Plow never got the message. It has to start with the words below — anything before them and Plow ignores it silently."
        : "Send the message from Messages and this screen will move on by itself. Nothing to type.",
    }),
    el("div", { class: "bigcode mono", text: activation ? activation.displayCode : "—" }),
    ...(activation ? sendInstructions(activation) : []),
    el("div", { class: "orow" }, [clock]),
    el("div", { class: "oactions" }, [
      button("Open Messages", "btn", async () => apply(await window.domo.onboardingOpenMessages())),
      el("div", { class: "spacer" }),
      // Re-polls the old code first: the app stops watching at five minutes but
      // the server honours it for thirty, so a text sent at minute six has
      // already worked and this button signs them straight in.
      button("Get a New Code", "btn primary", async () =>
        apply(await window.domo.onboardingNewCode()),
      ),
    ]),
    phoneCodeLink(),
    note(state),
  ];
}

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
      button("Back", "btn small", async () => apply(await window.domo.onboardingUseActivation())),
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
    state.step === "activate" ? activateScreen()
    : state.step === "waiting" ? waitingScreen()
    : state.step === "phone" ? phoneScreen()
    : state.step === "code" ? codeScreen()
    : state.step === "agent" ? agentScreen()
    : connectedScreen();
  root.replaceChildren(...screen.filter(Boolean));
  const focus = root.querySelector("input[autofocus]");
  if (focus && !state.busy) focus.focus();
  for (const b of root.querySelectorAll("button:not(.local)")) b.disabled = !!state.busy;
}

/* Every click here is `apply(await window.domo.something())`. If that invoke
   rejects — a handler that threw in main, or one that was never registered —
   the rejection is unhandled and the click silently does nothing, which is
   indistinguishable from a dead window. Surface it instead: the whole point of
   this screen is that a failure produces a sentence, never a spinner. */
window.addEventListener("unhandledrejection", (event) => {
  if (!state) return;
  event.preventDefault();
  state = { ...state, busy: false, message: "Something went wrong talking to the app. Try again." };
  render();
});

window.domo.onOnboardingChanged(async () => apply(await window.domo.onboardingGet()));

// `begin` mints the activation code on a first run and is a no-op otherwise, so
// reopening this window never burns a second code.
(async () => apply(await window.domo.onboardingBegin()))();
