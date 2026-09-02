/* First-run setup renderer. Main owns every transition and returns the whole
   state after each action; this file only redraws that state inside one
   persistent shell. The page is sandboxed and receives no Node primitives. */

import { el, icon } from "./dom.js";
import { singleFlight } from "./onboardingAction.js";
import { loadDoneAgent } from "./onboardingDone.js";
import { startAfterDocumentPaint } from "./welcomeEntrance.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const PLW_PATH =
  "M64.2891 6.03791C103.801 -2.33144 140.954 15.1702 152.051 56.9783L152.059 56.9705C163.194 98.9657 146.53 157.832 93.5537 167.899C82.3869 170.025 67.326 171.372 53.1455 170.259V396.001L4 395.954V84.8739C4.57639 47.1219 27.183 13.9013 64.2891 6.03791ZM135.946 194.909V332.057C136.211 340.271 142.121 344.787 149.122 346.5L149.13 346.492C150.843 346.912 153.701 347.192 155.469 347.192H164.098V395.945H153.709C120.777 396.934 91.746 371.249 87.1982 338.986C87.1671 338.41 87.1278 337.827 87.0889 337.251C86.5126 328.827 86.3027 320.379 86.3027 311.939V194.909H135.946ZM396.003 328.515C396.003 344.125 391.035 355.422 387.889 361.23C367.751 398.383 319.82 406.581 286.584 381.441C261.104 401.224 224.177 400.905 200.13 379.386C190.162 370.463 177.688 354.425 177.688 332.93V194.909H226.459C226.459 231.447 226.451 293.231 226.459 323.867C226.49 329.325 226.747 334.557 230.049 339.142C237.026 348.936 251.137 349.637 258.714 339.944C262.833 333.949 261.868 329.255 262.062 320.037V194.909H311.612C311.612 228.504 311.597 298.183 311.612 324.568C311.628 327.223 311.714 329.909 312.212 332.377C314.463 344.6 330.216 349.723 339.95 341.759C344.038 338.8 347.169 333.84 347.185 329.114C347.27 287.188 347.192 41.4011 347.216 4.06819H396.003V328.515ZM197.996 22.5194C236.8 -9.91499 297.01 1.78684 321.571 45.6815C340.884 78.9335 332.536 123.257 303.389 148.069H303.381L303.271 148.163C269 178.48 214.395 174.851 185.785 138.711C157.51 103.902 163.055 50.7341 197.996 22.5194ZM83.1182 51.6688C68.011 51.5365 58.6272 60.6846 54.7959 74.5428C53.6434 78.6847 53.1611 82.9903 53.1533 87.2957V123.249C61.1118 124.759 69.7794 125.507 77.0137 124.674V124.681C95.9831 122.782 107.617 107.662 107.695 85.7225C107.765 66.4379 98.8794 51.8011 83.1182 51.6688ZM284.582 95.1746C291.972 70.7904 269.958 46.6475 245.335 49.7459L245.202 49.7615C217.55 53.4598 202.98 88.5723 222.16 110.053C242.142 132.895 276.125 123.49 284.582 95.1746Z";

const root = document.getElementById("root");
let state = null;
let primaryAction = null;
let expiryTimer = null;
let fullDiskAccess = null;
let fullDiskProbe = null;
let fullDiskRequestBusy = false;
let restoreTelemetryFocus = false;
let doneAgent = null;
const mutate = singleFlight(() => state?.busy === true);

async function update(action) {
  await mutate(async () => apply(await action()));
}

function svgElement(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

function button(text, className, onClick) {
  const node = el("button", { class: className, text, attrs: { type: "button" } });
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

function arrowIcon(direction) {
  return icon(direction === "back" ? "arrowBack" : "arrowNext", { strokeWidth: "1.7" });
}

const titlebar = el("div", { class: "wizard-titlebar", attrs: { "aria-hidden": "true" } });
const screen = el("section", { class: "wizard-screen", attrs: { "aria-live": "polite" } });
const body = el("div", { class: "wizard-body" }, [screen]);
const backButton = button("", "nav-back", () => update(() => window.domo.onboardingBack()));
backButton.append(arrowIcon("back"), document.createTextNode("Back"));
const dots = [0, 1, 2].map(() => el("i", { class: "foot-dot" }));
const dotRow = el("span", { class: "foot-dots", attrs: { "aria-hidden": "true" } }, dots);
const primaryLabel = el("span", { text: "Get started" });
const primaryArrow = arrowIcon("next");
const primaryButton = el("button", { class: "nav-next", attrs: { type: "button" } }, [
  primaryLabel,
  primaryArrow,
]);
const footer = el("footer", { class: "wizard-footer" }, [backButton, dotRow, primaryButton]);
const shell = el("main", { class: "wizard-window", attrs: { "aria-label": "Plow Latch Set Up" } }, [
  titlebar,
  body,
  footer,
]);
root.replaceChildren(shell);

primaryButton.addEventListener("click", async () => {
  if (primaryAction && !primaryButton.disabled) await primaryAction();
});

function makeLogo() {
  const svg = svgElement("svg", {
    viewBox: "0 0 400 400",
    fill: "none",
    role: "img",
    "aria-label": "Plow",
  });
  const defs = svgElement("defs");
  const gradient = svgElement("linearGradient", {
    id: "plw-sheen",
    x1: "0",
    y1: "0",
    x2: "1",
    y2: "0.35",
    gradientUnits: "objectBoundingBox",
  });
  for (const [offset, opacity] of [["0%", "0"], ["42%", "0"], ["50%", "0.9"], ["58%", "0"], ["100%", "0"]]) {
    gradient.appendChild(svgElement("stop", {
      offset,
      "stop-color": "#ffffff",
      "stop-opacity": opacity,
    }));
  }
  const clip = svgElement("clipPath", { id: "plw-clip" });
  clip.appendChild(svgElement("path", { d: PLW_PATH }));
  defs.append(gradient, clip);

  const mark = svgElement("path", {
    class: "plw-mark",
    d: PLW_PATH,
    "fill-rule": "evenodd",
    "clip-rule": "evenodd",
  });
  const sheenGroup = svgElement("g", { "clip-path": "url(#plw-clip)" });
  sheenGroup.appendChild(svgElement("rect", {
    class: "plw-sheen",
    x: "-400",
    y: "0",
    width: "400",
    height: "400",
    fill: "url(#plw-sheen)",
  }));
  svg.append(defs, mark, sheenGroup);
  return el("div", { class: "welcome-logo" }, [svg]);
}

function welcomeScreen() {
  return el("div", { class: "welcome-wrap" }, [
    el("div", { class: "welcome-glow", attrs: { "aria-hidden": "true" } }),
    makeLogo(),
    el("p", { class: "welcome-eyebrow", text: "Presents" }),
    el("h1", { text: "Plow Latch" }),
    el("p", {
      class: "welcome-lead",
      text: "The privacy and security layer for agents. Plow Latch lives on your Mac, so nothing you don't want to share ever leaves your computer.",
    }),
    note(state),
  ]);
}

const TRUST_ROWS = [
  {
    title: "Data stays on your Mac",
    detail: "Your messages, calendar, and logins live on your Mac and reach an agent only through actions you approve.",
    glyph: "desktop",
  },
  {
    title: "You stay in control",
    detail: "Choose what runs automatically and what needs your approval.",
    glyph: "sliders",
  },
  {
    title: "A second AI checks the risky stuff",
    detail: "An independent reviewer catches actions that don't look right.",
    glyph: "shieldCheck",
  },
  {
    title: "Never sold. Never trained on.",
    detail: "Your data isn't sold, stored, or used to train AI models.",
    glyph: "lock",
  },
];

function privacyScreen() {
  const rows = TRUST_ROWS.map(({ title, detail, glyph }) =>
    el("div", { class: "trust-row" }, [
      el("span", { class: "trust-icon" }, [icon(glyph, { strokeWidth: "1.7" })]),
      el("span", { class: "trust-copy" }, [
        el("div", { class: "trust-title", text: title }),
        el("div", { class: "trust-detail", text: detail }),
      ]),
    ]),
  );
  return el("div", { class: "step-inner" }, [
    el("div", { class: "head-center" }, [
      el("h1", { text: "Privacy" }),
      el("p", {
        class: "subhead",
        text: "Your agents can get things done without giving up control of your data.",
      }),
    ]),
    el("div", { class: "trust-rows" }, rows),
  ]);
}

function copyButton(value) {
  const label = el("span", { text: "Copy" });
  const node = el("button", { class: "copy-button", attrs: { type: "button", "aria-label": "Copy message" } }, [
    icon("copy", { strokeWidth: "1.7" }),
    label,
  ]);
  node.addEventListener("click", async () => {
    await navigator.clipboard.writeText(value).then(() => {
      node.classList.add("copied");
      label.textContent = "Copied";
      setTimeout(() => {
        node.classList.remove("copied");
        label.textContent = "Copy";
      }, 2000);
    }).catch(() => {});
  });
  return node;
}

function activationMessage(activation) {
  const message = el("span", { class: "message-text" });
  const codeAt = activation.smsBody.lastIndexOf(activation.displayCode);
  if (codeAt < 0) {
    message.textContent = activation.smsBody;
  } else {
    message.append(
      document.createTextNode(activation.smsBody.slice(0, codeAt)),
      el("span", { class: "message-code", text: activation.displayCode }),
      document.createTextNode(activation.smsBody.slice(codeAt + activation.displayCode.length)),
    );
  }
  return message;
}

function note(current) {
  if (!current.busy && !current.message) return null;
  const kind = current.message
    ? current.noteKind === "neutral" ? " neutral" : " error"
    : "";
  return el("p", {
    class: `state-note${kind}`,
    text: current.message || "Talking to Plow…",
    attrs: { role: "status" },
  });
}

function startActivationCountdown(node, until) {
  const tick = () => {
    const left = Math.max(0, until - Date.now());
    const minutes = Math.floor(left / 60000);
    const seconds = Math.floor((left % 60000) / 1000);
    node.textContent = left > 0
      ? `Listening for ${minutes}:${String(seconds).padStart(2, "0")}`
      : "Still listening — you can try the same message or request another code.";
  };
  tick();
  expiryTimer = setInterval(tick, 1000);
}

function verifyScreen() {
  const activation = state.activation;
  const verified = state.step === "verified";
  const heading = [el("h1", { text: "Verify your phone to connect this Mac" })];
  if (activation || !verified) {
    heading.push(el("p", {
      class: "subhead",
      text: "Send the message below from the phone number you want to use with Plow.",
    }));
  }
  const parts = [
    el("div", { class: "head-center" }, heading),
  ];

  if (activation) {
    parts.push(
      el("div", { class: "send-block" }, [
        el("div", { class: "send-head" }, [
          el("span", { class: "section-label", text: "Send to:" }),
          el("span", { class: "send-to", text: activation.sendTo }),
        ]),
        el("div", { class: "message-field" }, [
          activationMessage(activation),
          copyButton(activation.smsBody),
        ]),
        el("p", { class: "caution" }, [
          icon("lock", { strokeWidth: "1.7" }),
          el("span", {}, [
            el("strong", { text: "Keep this private. " }),
            document.createTextNode("Anyone who sends this code from their number can link it to this Plow account."),
          ]),
        ]),
      ]),
    );
  } else if (!verified) {
    parts.push(el("p", { class: "state-note", text: "Getting a code from Plow…" }));
  }

  if (activation || verified) {
    const status = el("div", { class: `waiting-status${verified ? " verified" : ""}` }, [
      ...(verified
        ? [icon("checkmark", { class: "verified-check", strokeWidth: "1.7" })]
        : state.activationStale
          ? []
          : [el("span", { class: "waiting-spinner" })]),
      el("span", {
        class: "status-text",
        text: verified
          ? "Verified. This Mac is linked."
          : state.activationStale
            ? "Still not signed in"
            : "Waiting for your text…",
      }),
    ]);
    parts.push(status);

    if (activation && !verified) {
      const countdown = el("p", { class: "countdown", attrs: { "aria-live": "off" } });
      if (!state.activationStale) startActivationCountdown(countdown, activation.pollUntil);
      parts.push(countdown);
    }

    if (state.activationStale && !verified) {
      parts.push(el("div", { class: "inline-actions" }, [
        button("Try again", "link-button", () => update(() => window.domo.onboardingNewCode())),
      ]));
    }

    if (activation) {
      const activate = button(
        "",
        `verify-activate${verified ? " done" : ""}`,
        verified
          ? null
          : async () => {
              activate.disabled = true;
              activate.classList.add("sending");
              await update(() => window.domo.onboardingOpenMessages());
            },
      );
      activate.append(
        icon("messages", { strokeWidth: "1.7" }),
        document.createTextNode("Open Messages to activate"),
      );
      activate.disabled = verified;
      activate.setAttribute("aria-disabled", String(activate.disabled));

      const actions = [activate];
      if (!verified && !state.activationStale) {
        actions.push(el("p", { class: "alternate" }, [
          button("Still waiting? Send it again", "link-button", () =>
            update(() => window.domo.onboardingNewCode()),
          ),
        ]));
      }
      parts.push(el("div", { class: "verify-actions" }, actions));
    }
  } else {
    if (!state.busy) {
      parts.push(el("div", { class: "inline-actions" }, [
        button("Try again", "link-button", () => update(() => window.domo.onboardingBegin())),
      ]));
    }
  }

  parts.push(note(state));
  return el("div", { class: "step-inner" }, parts);
}

async function refreshFullDiskAccess(force = false) {
  if (!force && fullDiskAccess !== null) return;
  if (fullDiskProbe) return fullDiskProbe;
  fullDiskProbe = window.domo.capabilitiesGet()
    .then((capabilities) => {
      fullDiskAccess = capabilities?.fullDiskAccess === true;
    })
    .catch(() => {
      fullDiskAccess = false;
    })
    .finally(() => {
      fullDiskProbe = null;
      if (state?.step === "data") render();
    });
  return fullDiskProbe;
}

async function requestFullDiskAccess() {
  fullDiskRequestBusy = true;
  render();
  try {
    await window.domo.fullDiskGrantFlow();
  } finally {
    await refreshFullDiskAccess(true);
    fullDiskRequestBusy = false;
    if (state?.step === "data") render();
  }
}

function dataScreen() {
  const telemetry = el("input", {
    attrs: {
      id: "telemetry-toggle",
      type: "checkbox",
      "aria-label": "Share usage data",
    },
  });
  telemetry.checked = state.telemetryEnabled === true;
  telemetry.addEventListener("change", () => {
    restoreTelemetryFocus = true;
    void update(() => window.domo.onboardingSetTelemetry(telemetry.checked));
  });

  let permissionControl;
  if (fullDiskAccess === true) {
    permissionControl = button("", "req-btn granted", null);
    permissionControl.append(
      icon("checkmark", { strokeWidth: "1.7" }),
      document.createTextNode("Granted"),
    );
    permissionControl.disabled = true;
  } else {
    permissionControl = button(
      fullDiskRequestBusy || fullDiskAccess === null ? "Checking…" : "Request…",
      "req-btn",
      fullDiskRequestBusy || fullDiskAccess === null ? null : requestFullDiskAccess,
    );
    permissionControl.disabled = fullDiskRequestBusy || fullDiskAccess === null;
  }

  return el("div", { class: "data-screen" }, [
    el("div", { class: "step-inner" }, [
      el("div", { class: "head-center" }, [
        el("h1", { text: "Your data & permissions" }),
        el("p", { class: "subhead", text: "You can change any of these anytime in Settings." }),
      ]),
      el("div", { class: "data-consent" }, [
        el("div", { class: "section-heading", text: "Help make Plow better?" }),
        el("div", { class: "toggle-row" }, [
          el("span", { class: "toggle-copy" }, [
            el("span", { class: "toggle-detail" }, [
              el("strong", { text: "Share usage data so we can improve Plow. " }),
              document.createTextNode("Never your messages or your data."),
            ]),
          ]),
          el("label", { class: "switch" }, [
            telemetry,
            el("span", { class: "track", attrs: { "aria-hidden": "true" } }),
            el("span", { class: "knob", attrs: { "aria-hidden": "true" } }),
          ]),
        ]),
      ]),
      el("div", { class: "data-divider" }),
      el("div", { class: "section-label permission-label", text: "Permissions" }),
      el("div", { class: "permission-rows" }, [
        el("div", { class: "permission-row" }, [
          el("span", { class: "permission-icon" }, [
            icon("hardDrive", { strokeWidth: "1.7" }),
          ]),
          el("span", { class: "permission-copy" }, [
            el("span", { class: "permission-name" }, [
              document.createTextNode("Full Disk Access "),
              el("span", { class: "optional-label", text: "Optional" }),
            ]),
            el("span", {
              class: "permission-detail",
              text: "Plow Latch reads your Messages right on your Mac, so you never miss the texts that matter. Apple keeps Messages behind this permission. Only what you approve an agent to read is ever sent to it.",
            }),
          ]),
          el("span", { class: "permission-control" }, [permissionControl]),
        ]),
      ]),
    ]),
  ]);
}

function doneScreen() {
  const actions = [];
  if (doneAgent) {
    actions.push(button(`Text ${doneAgent.name}`, "nav-next", async () => {
      await window.domo.cloudOpenMessages(doneAgent.agentId);
    }));
  }
  actions.push(button(
    "Explore the app",
    doneAgent ? "nav-back done-explore" : "nav-next",
    () => update(() => window.domo.onboardingFinish()),
  ));
  return el("div", { class: "done-wrap" }, [
    el("div", { class: "done-badge" }, [
      icon("checkmark", { strokeWidth: "2.4" }),
    ]),
    el("h1", { text: "You're all set" }),
    el("div", { class: "done-actions" }, actions),
  ]);
}

function screenForStep() {
  if (state.step === "welcome") return welcomeScreen();
  if (state.step === "privacy") return privacyScreen();
  if (state.step === "activate" || state.step === "waiting" || state.step === "verified") {
    return verifyScreen();
  }
  if (state.step === "data") return dataScreen();
  if (state.step === "done") return doneScreen();
  return el("p", { class: "state-note error", text: "This setup step is unavailable." });
}

function footerForStep() {
  const step = state.step;
  if (step === "done") return { hidden: true };
  if (step === "welcome") {
    return {
      back: false,
      dot: null,
      label: "Get started",
      arrow: false,
      action: () => update(() => window.domo.onboardingAdvance()),
    };
  }
  if (step === "privacy") {
    return {
      back: true,
      dot: 0,
      label: "Continue",
      arrow: true,
      action: () => update(() => window.domo.onboardingAdvance()),
    };
  }
  if (step === "activate" || step === "waiting" || step === "verified") {
    const verified = step === "verified";
    return {
      back: !verified,
      dot: 1,
      label: "Continue",
      arrow: true,
      disabled: !verified,
      action: verified
        ? () => update(() => window.domo.onboardingAdvance())
        : null,
    };
  }
  return {
    back: false,
    dot: 2,
    label: "Continue",
    arrow: true,
    action: () => update(() => window.domo.onboardingAdvance()),
  };
}

function playWelcomeEntrance(variant) {
  const mark = screen.querySelector(".plw-mark");
  void startAfterDocumentPaint(() => {
    if (!mark.isConnected) return;
    if (variant === "full" && typeof mark.getTotalLength === "function") {
      try {
        const length = Math.ceil(mark.getTotalLength());
        if (length > 0) screen.style.setProperty("--plw-len", length);
      } catch {
        // Layout-free test environments can lack SVG geometry. The CSS has a
        // conservative fallback length and the filled resting mark still shows.
      }
    }
    screen.classList.add(`entering-${variant}`);
    document.body.classList.add(`welcome-${variant}`);
  });
}

function refreshWelcomeNote() {
  const wrap = screen.querySelector(".welcome-wrap");
  if (!wrap) return;
  wrap.querySelector(".state-note")?.remove();
  const next = note(state);
  if (next) wrap.append(next);
}

function render() {
  if (!state) return;
  clearInterval(expiryTimer);
  expiryTimer = null;
  if (state.step !== "data") restoreTelemetryFocus = false;

  const continuingWelcome = state.step === "welcome" && screen.classList.contains("is-welcome");
  if (continuingWelcome) {
    refreshWelcomeNote();
  } else {
    screen.className = `wizard-screen is-${state.step}`;
    screen.replaceChildren(screenForStep());
    body.scrollTop = 0;
    document.body.classList.remove("welcome-full", "welcome-short");
  }
  document.body.classList.toggle("on-welcome", state.step === "welcome");

  const config = footerForStep();
  footer.hidden = !!config.hidden;
  if (!config.hidden) {
    backButton.hidden = !config.back;
    backButton.disabled = !!state.busy;
    dotRow.hidden = config.dot === null;
    dots.forEach((dot, index) => {
      dot.classList.toggle("active", index === config.dot);
      dot.classList.toggle("complete", config.dot !== null && index < config.dot);
    });
    primaryLabel.textContent = config.label;
    primaryArrow.toggleAttribute("hidden", !config.arrow);
    primaryButton.disabled = !!config.disabled || (!!state.busy && state.step !== "verified");
    primaryAction = config.action;
  } else {
    primaryAction = null;
  }

  if (state.step === "welcome" && !continuingWelcome) {
    const variant = state.welcomeEntrancePlayed ? "short" : "full";
    playWelcomeEntrance(variant);
  }
  if (state.step === "data") void refreshFullDiskAccess();

  const telemetryFocus = restoreTelemetryFocus
    ? screen.querySelector("#telemetry-toggle")
    : null;
  const focus = telemetryFocus ?? screen.querySelector("input[autofocus]")
    ?? (primaryButton.disabled ? screen.querySelector(".verify-activate:not(:disabled)") : null)
    ?? (!footer.hidden ? primaryButton : null);
  if (focus && !state.busy) {
    requestAnimationFrame(() => {
      focus.focus({ preventScroll: true, focusVisible: false });
      if (focus === telemetryFocus) restoreTelemetryFocus = false;
    });
  }
}

async function apply(next) {
  const previousStep = state?.step;
  if (next) state = next;
  if (state?.step !== "done") doneAgent = null;
  render();
  if (state?.step === "done" && previousStep !== "done") {
    const loaded = await loadDoneAgent(() => window.domo.cloudAgents());
    if (state?.step !== "done") return;
    doneAgent = loaded;
    render();
  }
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.defaultPrevented || footer.hidden || primaryButton.disabled) return;
  if (event.target instanceof HTMLButtonElement) return;
  event.preventDefault();
  primaryButton.click();
});

window.addEventListener("unhandledrejection", (event) => {
  if (!state) return;
  event.preventDefault();
  state = {
    ...state,
    busy: false,
    message: "Something went wrong talking to the app. Try again.",
    noteKind: "error",
  };
  render();
});

window.addEventListener("focus", () => {
  if (state?.step === "data") void refreshFullDiskAccess(true);
});

window.domo.onOnboardingChanged(async () => apply(await window.domo.onboardingGet()));
apply(await window.domo.onboardingGet());
