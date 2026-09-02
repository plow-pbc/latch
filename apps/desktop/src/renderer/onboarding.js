/* First-run setup renderer. Main owns every transition and returns the whole
   state after each action; this file only redraws that state inside one
   persistent shell. The page is sandboxed and receives no Node primitives. */

const SVG_NS = "http://www.w3.org/2000/svg";
const PLW_PATH =
  "M64.2891 6.03791C103.801 -2.33144 140.954 15.1702 152.051 56.9783L152.059 56.9705C163.194 98.9657 146.53 157.832 93.5537 167.899C82.3869 170.025 67.326 171.372 53.1455 170.259V396.001L4 395.954V84.8739C4.57639 47.1219 27.183 13.9013 64.2891 6.03791ZM135.946 194.909V332.057C136.211 340.271 142.121 344.787 149.122 346.5L149.13 346.492C150.843 346.912 153.701 347.192 155.469 347.192H164.098V395.945H153.709C120.777 396.934 91.746 371.249 87.1982 338.986C87.1671 338.41 87.1278 337.827 87.0889 337.251C86.5126 328.827 86.3027 320.379 86.3027 311.939V194.909H135.946ZM396.003 328.515C396.003 344.125 391.035 355.422 387.889 361.23C367.751 398.383 319.82 406.581 286.584 381.441C261.104 401.224 224.177 400.905 200.13 379.386C190.162 370.463 177.688 354.425 177.688 332.93V194.909H226.459C226.459 231.447 226.451 293.231 226.459 323.867C226.49 329.325 226.747 334.557 230.049 339.142C237.026 348.936 251.137 349.637 258.714 339.944C262.833 333.949 261.868 329.255 262.062 320.037V194.909H311.612C311.612 228.504 311.597 298.183 311.612 324.568C311.628 327.223 311.714 329.909 312.212 332.377C314.463 344.6 330.216 349.723 339.95 341.759C344.038 338.8 347.169 333.84 347.185 329.114C347.27 287.188 347.192 41.4011 347.216 4.06819H396.003V328.515ZM197.996 22.5194C236.8 -9.91499 297.01 1.78684 321.571 45.6815C340.884 78.9335 332.536 123.257 303.389 148.069H303.381L303.271 148.163C269 178.48 214.395 174.851 185.785 138.711C157.51 103.902 163.055 50.7341 197.996 22.5194ZM83.1182 51.6688C68.011 51.5365 58.6272 60.6846 54.7959 74.5428C53.6434 78.6847 53.1611 82.9903 53.1533 87.2957V123.249C61.1118 124.759 69.7794 125.507 77.0137 124.674V124.681C95.9831 122.782 107.617 107.662 107.695 85.7225C107.765 66.4379 98.8794 51.8011 83.1182 51.6688ZM284.582 95.1746C291.972 70.7904 269.958 46.6475 245.335 49.7459L245.202 49.7615C217.55 53.4598 202.98 88.5723 222.16 110.053C242.142 132.895 276.125 123.49 284.582 95.1746Z";

const root = document.getElementById("root");
let state = null;
let primaryAction = null;
let expiryTimer = null;

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs) {
    for (const [name, value] of Object.entries(opts.attrs)) node.setAttribute(name, value);
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function svgElement(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

function icon(shapes, className = "") {
  const svg = svgElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.7",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  });
  if (className) svg.setAttribute("class", className);
  for (const [tag, attrs] of shapes) svg.appendChild(svgElement(tag, attrs));
  return svg;
}

function button(text, className, onClick) {
  const node = el("button", { class: className, text, attrs: { type: "button" } });
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

function arrowIcon(direction) {
  const path = direction === "back" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6";
  return icon([["path", { d: path }]]);
}

const titlebar = el("div", { class: "wizard-titlebar", attrs: { "aria-hidden": "true" } });
const screen = el("section", { class: "wizard-screen", attrs: { "aria-live": "polite" } });
const body = el("div", { class: "wizard-body" }, [screen]);
const backButton = button("", "nav-back", async () => apply(await window.domo.onboardingBack()));
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
const shell = el("main", { class: "wizard-window", attrs: { "aria-label": "Plow Latch — Set Up" } }, [
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
      text: "The privacy and security layer for Plow. Plow Latch lives on your Mac, so nothing you don't want to share ever leaves your computer.",
    }),
    note(state),
  ]);
}

const TRUST_ROWS = [
  {
    title: "It all stays on your Mac",
    detail: "Your messages, calendar, and logins live here, not on our servers. We couldn't read them if we tried.",
    shapes: [
      ["rect", { x: "2.5", y: "4", width: "19", height: "12", rx: "2" }],
      ["path", { d: "M8.5 20h7M12 16v4" }],
    ],
  },
  {
    title: "You decide what needs your okay",
    detail: "Approve every action yourself, or set rules so only the risky stuff asks first. Always your call, always logged.",
    shapes: [
      ["path", { d: "M5 7h14M5 12h14M5 17h14" }],
      ["circle", { cx: "9", cy: "7", r: "2.1" }],
      ["circle", { cx: "15", cy: "12", r: "2.1" }],
      ["circle", { cx: "8", cy: "17", r: "2.1" }],
    ],
  },
  {
    title: "A second AI has your back",
    detail: "Flip on the adversarial reviewer and an independent agent inspects risky actions before they run — a built-in skeptic that catches what you might miss.",
    shapes: [
      ["path", { d: "M12 3l7 4v6c0 4-3 6.5-7 8-4-1.5-7-4-7-8V7z" }],
      ["path", { d: "M9.2 12.4l1.9 1.9 3.7-4" }],
    ],
  },
  {
    title: "Never sold, never trained on",
    detail: "We don't sell your data, and we hold zero-retention agreements with the language-model providers — so nothing you share is stored or trained on. Full stop.",
    shapes: [
      ["rect", { x: "5", y: "11", width: "14", height: "9", rx: "2" }],
      ["path", { d: "M8 11V8a4 4 0 0 1 8 0v3" }],
    ],
  },
];

function privacyScreen() {
  const rows = TRUST_ROWS.map(({ title, detail, shapes }) =>
    el("div", { class: "trust-row" }, [
      el("span", { class: "trust-icon" }, [icon(shapes)]),
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
        text: "Plow works best with access to your messages, calendar, and accounts — so your agents can actually help. Here's what makes Plow different:",
      }),
    ]),
    el("div", { class: "trust-rows" }, rows),
  ]);
}

function copyButton(value) {
  const label = el("span", { text: "Copy" });
  const node = el("button", { class: "copy-button", attrs: { type: "button", "aria-label": "Copy message" } }, [
    icon([
      ["rect", { x: "9", y: "9", width: "11", height: "11", rx: "2.5" }],
      ["path", { d: "M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" }],
    ]),
    label,
  ]);
  node.addEventListener("click", async () => {
    await navigator.clipboard.writeText(value);
    node.classList.add("copied");
    label.textContent = "Copied";
    setTimeout(() => {
      node.classList.remove("copied");
      label.textContent = "Copy";
    }, 2000);
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
  return el("p", {
    class: `state-note${current.message ? " error" : ""}`,
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
  const parts = [
    el("div", { class: "head-center" }, [
      el("h1", { text: "Verify your phone to connect this Mac" }),
      el("p", {
        class: "subhead",
        text: "Send the message below from the phone number you want to use with Plow.",
      }),
    ]),
  ];

  if (activation) {
    const countdown = el("p", { class: "countdown" });
    if (!state.activationStale) startActivationCountdown(countdown, activation.pollUntil);
    parts.push(
      el("div", { class: "send-block" }, [
        el("div", { class: "send-head" }, [
          el("span", { class: "section-label", text: "Send to" }),
          el("span", { class: "send-to", text: activation.sendTo }),
        ]),
        el("div", { class: "message-field" }, [
          activationMessage(activation),
          copyButton(activation.smsBody),
        ]),
        el("p", { class: "caution" }, [
          icon([
            ["rect", { x: "5", y: "11", width: "14", height: "9", rx: "2" }],
            ["path", { d: "M8 11V8a4 4 0 0 1 8 0v3" }],
          ]),
          el("span", {}, [
            el("strong", { text: "Keep this private. " }),
            document.createTextNode("Anyone who sends this code from their number can link it to this Plow account."),
          ]),
        ]),
      ]),
      el("div", { class: "waiting-status" }, [
        ...(state.activationStale ? [] : [el("span", { class: "waiting-spinner" })]),
        document.createTextNode(state.activationStale ? "Still not signed in" : "Waiting for your text…"),
      ]),
      countdown,
    );
    if (state.activationStale) {
      parts.push(el("div", { class: "inline-actions" }, [
        button("Try again", "link-button", async () => apply(await window.domo.onboardingNewCode())),
      ]));
    }
    parts.push(el("p", { class: "alternate" }, [
      button("Use a phone code instead", "link-button", async () =>
        apply(await window.domo.onboardingUsePhoneCode()),
      ),
    ]));
  } else {
    parts.push(el("p", { class: "state-note", text: "Getting a code from Plow…" }));
  }

  parts.push(note(state));
  return el("div", { class: "step-inner" }, parts);
}

function phoneScreen() {
  const input = el("input", {
    class: "text-input",
    attrs: {
      id: "phone-input",
      type: "tel",
      autocomplete: "tel",
      placeholder: "+1 555 123 4567",
      autofocus: "",
    },
  });
  input.value = state.phone || "";
  return el("div", { class: "step-inner" }, [
    el("div", { class: "head-center" }, [
      el("h1", { text: "Sign in to Plow" }),
      el("p", {
        class: "subhead",
        text: "Enter the phone number on your Plow account. We'll text you a code.",
      }),
    ]),
    el("div", { class: "fallback-form" }, [
      el("label", { class: "field-label", text: "Phone number", attrs: { for: "phone-input" } }),
      input,
    ]),
    note(state),
  ]);
}

function codeScreen() {
  const input = el("input", {
    class: "text-input code-input",
    attrs: {
      id: "code-input",
      inputmode: "numeric",
      maxlength: "8",
      autocomplete: "one-time-code",
      placeholder: "12345678",
      autofocus: "",
    },
  });
  const expiry = el("p", { class: "countdown" });
  const tick = () => {
    if (!state.codeExpiresAt) {
      expiry.textContent = "";
      return;
    }
    const left = Math.max(0, state.codeExpiresAt - Date.now());
    const minutes = Math.floor(left / 60000);
    const seconds = Math.floor((left % 60000) / 1000);
    expiry.textContent = left > 0
      ? `Expires in ${minutes}:${String(seconds).padStart(2, "0")}`
      : "This code has expired.";
  };
  tick();
  expiryTimer = setInterval(tick, 1000);

  return el("div", { class: "step-inner" }, [
    el("div", { class: "head-center" }, [
      el("h1", { text: "Check your phone" }),
      el("p", {
        class: "subhead",
        text: `If ${state.phone} is on a Plow account, an 8-digit code is on its way.`,
      }),
    ]),
    el("div", { class: "fallback-form" }, [
      el("label", { class: "field-label", text: "Code", attrs: { for: "code-input" } }),
      input,
      expiry,
      el("div", { class: "inline-actions" }, [
        button("Change number", "link-button", async () =>
          apply(await window.domo.onboardingEditPhone()),
        ),
        button("Resend", "link-button", async () =>
          apply(await window.domo.onboardingResendCode()),
        ),
      ]),
    ]),
    note(state),
  ]);
}

/* These two lightweight states keep the whole persistent shell inspectable.
   Their actions still come from main; no local transition is introduced. */
function dataPreviewScreen() {
  const granted = !!state.fullDiskAccess;
  return el("div", { class: "data-preview" }, [
    el("div", { class: "step-inner" }, [
      el("div", { class: "head-center" }, [el("h1", { text: "Your data & permissions" })]),
      el("div", { class: "preview-card" }, [
        el("div", { class: "preview-title", text: "Help make Plow better?" }),
        el("div", {
          class: "preview-detail",
          text: state.telemetryEnabled
            ? "Yes, help improve Plow — never your messages or your data."
            : "No thanks. We won't know how you use the app.",
        }),
      ]),
      el("div", { class: "preview-card" }, [
        el("div", { class: "preview-title", text: "Full Disk Access" }),
        el("div", { class: "preview-detail", text: "so your agent can read and send your iMessages" }),
        ...(granted ? [el("div", { class: "permission-state", text: "Granted" })] : []),
      ]),
      el("p", { class: "state-note", text: "Change any of these anytime in Settings." }),
    ]),
  ]);
}

function donePreviewScreen() {
  const children = [
    el("div", { class: "done-badge" }, [
      icon([["path", { d: "M20 6L9 17l-5-5", "stroke-width": "2.4" }]]),
    ]),
    el("h1", { text: "You're all set" }),
  ];
  if (state.agent?.name) {
    children.push(button(`Text ${state.agent.name}`, "nav-next", async () => {
      if (window.domo.onboardingMessageAgent) await window.domo.onboardingMessageAgent();
    }));
  }
  children.push(button("Explore the app", "link-button", () => window.domo.onboardingFinish()));
  return el("div", { class: "done-preview" }, children);
}

function screenForStep() {
  if (state.step === "welcome") return welcomeScreen();
  if (state.step === "privacy") return privacyScreen();
  if (state.step === "activate" || state.step === "waiting") return verifyScreen();
  if (state.step === "phone") return phoneScreen();
  if (state.step === "code") return codeScreen();
  if (state.step === "data") return dataPreviewScreen();
  if (state.step === "done") return donePreviewScreen();
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
      action: async () => apply(await window.domo.onboardingAdvance()),
    };
  }
  if (step === "privacy") {
    return {
      back: true,
      dot: 0,
      label: "Continue",
      arrow: true,
      action: async () => apply(await window.domo.onboardingAdvance()),
    };
  }
  if (step === "activate" || step === "waiting") {
    return {
      back: true,
      dot: 1,
      label: state.activation ? "Open Messages" : "Try again",
      arrow: false,
      action: state.activation
        ? async () => apply(await window.domo.onboardingOpenMessages())
        : async () => apply(await window.domo.onboardingBegin()),
    };
  }
  if (step === "phone") {
    return {
      back: true,
      dot: 1,
      label: "Send code",
      arrow: false,
      action: async () => {
        const input = document.getElementById("phone-input");
        apply(await window.domo.onboardingRequestCode(input?.value ?? ""));
      },
    };
  }
  if (step === "code") {
    return {
      back: true,
      dot: 1,
      label: "Sign in",
      arrow: false,
      action: async () => {
        const input = document.getElementById("code-input");
        apply(await window.domo.onboardingSubmitCode(input?.value ?? ""));
      },
    };
  }
  return {
    back: false,
    dot: 2,
    label: "Continue",
    arrow: true,
    action: async () => apply(await window.domo.onboardingAdvance()),
  };
}

function playWelcomeEntrance() {
  const mark = screen.querySelector(".plw-mark");
  if (!mark || typeof mark.getTotalLength !== "function") return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!mark.isConnected) return;
      try {
        const length = Math.ceil(mark.getTotalLength());
        if (length > 0) screen.style.setProperty("--plw-len", length);
      } catch {
        // Layout-free test environments can lack SVG geometry. The CSS has a
        // conservative fallback length and the filled resting mark still shows.
      }
      screen.classList.add("entering");
    });
  });
}

function render() {
  if (!state) return;
  clearInterval(expiryTimer);
  expiryTimer = null;

  screen.className = `wizard-screen is-${state.step}`;
  screen.replaceChildren(screenForStep());
  body.scrollTop = 0;
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
    primaryButton.disabled = !!state.busy;
    primaryAction = config.action;
  } else {
    primaryAction = null;
  }

  if (state.step === "welcome") playWelcomeEntrance();

  const focus = screen.querySelector("input[autofocus]") ?? (!footer.hidden ? primaryButton : null);
  if (focus && !state.busy) {
    requestAnimationFrame(() => focus.focus({ preventScroll: true, focusVisible: false }));
  }
}

async function apply(next) {
  if (next) state = next;
  render();
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
  };
  render();
});

window.domo.onOnboardingChanged(async () => apply(await window.domo.onboardingGet()));
apply(await window.domo.onboardingGet());
