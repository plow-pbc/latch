/* First-run setup renderer. Main owns every transition and returns the whole
   state after each action; this file only redraws that state inside one
   persistent shell. The page is sandboxed and receives no Node primitives. */

import { el, icon, switchEl } from "./dom.js";
import { latestOnly, singleFlight, whenAnswered } from "./onboardingAction.js";
import { loadDoneAgent } from "./onboardingDone.js";
import { failedOnboardingState, resolveOnboardingState } from "./onboardingFallback.js";
import { presetFor, rowView, verdictWord } from "./gatekeeperRows.js";
import { accessPrimary, runGrants } from "./onboardingGrants.js";
import { startAfterDocumentPaint } from "./welcomeEntrance.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const PLW_PATH =
  "M64.2891 6.03791C103.801 -2.33144 140.954 15.1702 152.051 56.9783L152.059 56.9705C163.194 98.9657 146.53 157.832 93.5537 167.899C82.3869 170.025 67.326 171.372 53.1455 170.259V396.001L4 395.954V84.8739C4.57639 47.1219 27.183 13.9013 64.2891 6.03791ZM135.946 194.909V332.057C136.211 340.271 142.121 344.787 149.122 346.5L149.13 346.492C150.843 346.912 153.701 347.192 155.469 347.192H164.098V395.945H153.709C120.777 396.934 91.746 371.249 87.1982 338.986C87.1671 338.41 87.1278 337.827 87.0889 337.251C86.5126 328.827 86.3027 320.379 86.3027 311.939V194.909H135.946ZM396.003 328.515C396.003 344.125 391.035 355.422 387.889 361.23C367.751 398.383 319.82 406.581 286.584 381.441C261.104 401.224 224.177 400.905 200.13 379.386C190.162 370.463 177.688 354.425 177.688 332.93V194.909H226.459C226.459 231.447 226.451 293.231 226.459 323.867C226.49 329.325 226.747 334.557 230.049 339.142C237.026 348.936 251.137 349.637 258.714 339.944C262.833 333.949 261.868 329.255 262.062 320.037V194.909H311.612C311.612 228.504 311.597 298.183 311.612 324.568C311.628 327.223 311.714 329.909 312.212 332.377C314.463 344.6 330.216 349.723 339.95 341.759C344.038 338.8 347.169 333.84 347.185 329.114C347.27 287.188 347.192 41.4011 347.216 4.06819H396.003V328.515ZM197.996 22.5194C236.8 -9.91499 297.01 1.78684 321.571 45.6815C340.884 78.9335 332.536 123.257 303.389 148.069H303.381L303.271 148.163C269 178.48 214.395 174.851 185.785 138.711C157.51 103.902 163.055 50.7341 197.996 22.5194ZM83.1182 51.6688C68.011 51.5365 58.6272 60.6846 54.7959 74.5428C53.6434 78.6847 53.1611 82.9903 53.1533 87.2957V123.249C61.1118 124.759 69.7794 125.507 77.0137 124.674V124.681C95.9831 122.782 107.617 107.662 107.695 85.7225C107.765 66.4379 98.8794 51.8011 83.1182 51.6688ZM284.582 95.1746C291.972 70.7904 269.958 46.6475 245.335 49.7459L245.202 49.7615C217.55 53.4598 202.98 88.5723 222.16 110.053C242.142 132.895 276.125 123.49 284.582 95.1746Z";

const root = document.getElementById("root");
let state = null;
let primaryAction = null;
let expiryTimer = null;
/** The Availability screen's two switches, read fresh from the OS/disk on
 * entering the step and on window focus — never remembered across steps. */
let availability = null;
/** Set by availabilityScreen(); moves the live switches to `availability`
 * without a re-render, so a click keeps its focus. */
let syncAvailability = null;
/** The Plugins tab's state (pluginsGet): the rows setup switches and the
 * ordered grants Access walks. Read fresh on entering either step and on
 * window focus — null on every other step. */
let pluginsState = null;
/** Access's own run: the grants the owner skipped (kept across Back and
 * Availability, dropped when setup leaves those steps), the one whose flow is
 * running (the run's own, set until its act returns), and the one that
 * stopped it ({ id, error }, cleared on any step change). */
const skipped = new Set();
let running = null;
let missed = null;
/** The id of the switch a redraw hands focus back to, so a click keeps it. */
let restoreFocus = null;
let doneAgent = null;
/** The Gatekeeper screen's live pieces. Built on entering the step and updated
 * in place, so typing never loses its focus to a redraw. */
let gatekeeper = null;
let gatekeeperPresets = null;
/** The deck last shown, so an edited draft comes back from Plugins with its own examples. */
let lastDeck = null;
const PREVIEW_PAUSE_MS = 1000;
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
const dots = [0, 1, 2, 3, 4, 5].map(() => el("i", { class: "foot-dot" }));
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
    el("h1", {}, [
      el("span", { text: "Keep your passwords." }),
      el("span", { class: "kick", text: "Lose the busywork." }),
    ]),
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
    title: "The Plow gatekeeper reviews every data request",
    detail: "The Plow adversarial reviewer catches actions that don't look right.",
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
    el("div", { class: "waiting-status verified" }, [
      icon("checkmark", { class: "verified-check", strokeWidth: "1.7" }),
      el("span", { class: "status-text", text: "Verified. This Mac is linked." }),
    ]),
    el("div", { class: "head-center" }, [
      el("h1", { text: "Stay in control of how your AI agents use your data" }),
      el("p", {
        class: "subhead",
        text: "Your agents can get things done without giving up control of your data.",
      }),
    ]),
    el("div", { class: "trust-rows" }, rows),
    note(state),
  ]);
}

const MINI_STROKE = "rgba(240,240,232,.34)";
const PORT_STROKE = "rgba(240,240,232,.42)";

/** The Mac mini, drawn — monochrome lines, no logo. Its status light and
 * underglow pulse when a request gets through. */
function macMini() {
  const svg = svgElement("svg", { viewBox: "0 0 120 86", fill: "none", "aria-hidden": "true" });
  const defs = svgElement("defs");
  const grad = (tag, id, attrs, stops) => {
    const g = svgElement(tag, { id, ...attrs });
    for (const [offset, color, opacity] of stops) {
      g.appendChild(svgElement("stop", { offset, "stop-color": color, "stop-opacity": opacity }));
    }
    return g;
  };
  defs.append(
    grad("linearGradient", "gk-mm-top", { x1: "0", y1: "0", x2: "0", y2: "1" }, [["0", "#1b1c18", "1"], ["1", "#222420", "1"]]),
    grad("linearGradient", "gk-mm-front", { x1: "0", y1: "0", x2: "0", y2: "1" }, [["0", "#191a16", "1"], ["1", "#121310", "1"]]),
    grad("radialGradient", "gk-mm-under", { cx: ".5", cy: ".5", r: ".5" }, [["0", "#d5ef8a", ".55"], ["1", "#d5ef8a", "0"]]),
    grad("radialGradient", "gk-mm-led", { cx: ".5", cy: ".5", r: ".5" }, [["0", "#eaffb0", "1"], [".35", "#d5ef8a", ".8"], ["1", "#d5ef8a", "0"]]),
  );
  svg.append(
    defs,
    svgElement("ellipse", { class: "gk-glow", cx: "60", cy: "77", rx: "54", ry: "6", fill: "url(#gk-mm-under)" }),
    svgElement("ellipse", { cx: "60", cy: "75.5", rx: "50", ry: "2.6", fill: "rgba(0,0,0,.55)" }),
    svgElement("path", { d: "M8.5 36 H111.5 V65 Q111.5 74 102 74 H18 Q8.5 74 8.5 65 Z", fill: "url(#gk-mm-front)", stroke: MINI_STROKE, "stroke-width": "1.3", "stroke-linejoin": "round" }),
    svgElement("path", { d: "M17 23 Q18 18 26 18 H94 Q102 18 103 23 L111 32 Q113 36.5 107 36.5 H13 Q7 36.5 9 32 Z", fill: "url(#gk-mm-top)", stroke: MINI_STROKE, "stroke-width": "1.3", "stroke-linejoin": "round" }),
    svgElement("path", { d: "M13 36 H107", stroke: "rgba(240,240,232,.12)", "stroke-width": "1" }),
    svgElement("rect", { x: "23", y: "53", width: "3.6", height: "10", rx: "1.8", stroke: PORT_STROKE, "stroke-width": "1.1" }),
    svgElement("rect", { x: "31", y: "53", width: "3.6", height: "10", rx: "1.8", stroke: PORT_STROKE, "stroke-width": "1.1" }),
    svgElement("circle", { cx: "96", cy: "58", r: "2.3", stroke: PORT_STROKE, "stroke-width": "1.1" }),
    svgElement("circle", { class: "gk-glow", cx: "86", cy: "58", r: "5", fill: "url(#gk-mm-led)" }),
    svgElement("circle", { cx: "86", cy: "58", r: ".9", fill: "rgba(240,240,232,.5)" }),
  );
  return el("div", { class: "gk-mac" }, [el("div", { class: "gk-halo" }), svg]);
}

/** One row as its latest result reads; the beam scans while any row is out. */
function paintRow(index) {
  const g = gatekeeper;
  const { state: rowState, reason } = rowView(g.results[index]);
  const row = g.view.rows[index];
  row.node.className = `gk-row ${rowState}${g.open.has(index) ? " open" : ""}`;
  row.pill.setAttribute("aria-expanded", String(g.open.has(index)));
  const word = verdictWord(rowState);
  row.end.textContent = rowState === "ok" ? "✓" : rowState === "no" ? "✕" : rowState === "checking" ? word : "";
  row.word.textContent = word;
  row.reason.textContent = reason ? ` — ${reason}` : "";
  // Restart the flare so a re-review flashes again.
  const flare = el("span", { class: "gk-flare" });
  row.flare.replaceWith(flare);
  row.flare = flare;
  g.view.field.classList.toggle("reviewing", g.results.some((result) => !result));
}

function lightMac(view) {
  view.mac.classList.remove("lit");
  void view.mac.offsetWidth;
  view.mac.classList.add("lit");
  setTimeout(() => view.mac.classList.remove("lit"), 260);
}

/** Every row back to checking, for `text`; an open row stays open to watch its
 * re-review. Answers still out for older text land on a stale generation and
 * are dropped. */
function invalidate(g, text) {
  g.lastText = text.trim();
  g.results = g.results.map(() => null);
  g.results.forEach((_, i) => paintRow(i));
  return ++g.gen;
}

/** Review every row of the current deck against the text in the field. A newer
 * run supersedes an older one; its late answers are dropped, not cancelled. */
function runPreview() {
  const g = gatekeeper;
  if (!g?.view) return;
  // A pending debounce is for text this run already covers (or a deck it replaced).
  clearTimeout(g.timer);
  const text = g.text;
  const gen = invalidate(g, text);
  g.results.forEach((_, i) => {
    window.domo.gatekeeperPreview(g.deck, i, text)
      .catch(() => ({ verdict: "ask", reason: "", cause: "unavailable" }))
      .then((result) => {
        if (gatekeeper !== g || g.gen !== gen) return;
        g.results[i] = result;
        paintRow(i);
        if (result.verdict === "allow") setTimeout(() => lightMac(g.view), 420);
      });
  });
}

function schedulePreview() {
  clearTimeout(gatekeeper.timer);
  gatekeeper.timer = setTimeout(() => runPreview(), PREVIEW_PAUSE_MS);
}

function choosePreset(key) {
  const g = gatekeeper;
  g.deck = lastDeck = key;
  g.text = gatekeeperPresets[key].text;
  g.results = gatekeeperPresets[key].rows.map(() => null);
  g.open.clear();
  g.view = null; // render() rebuilds a screen with no view
  render();
  runPreview();
}

function gatekeeperScreen() {
  const head = el("div", { class: "head-center" }, [
    el("h1", { text: "Meet the Plow Gatekeeper" }),
    el("p", { class: "subhead" }, [
      document.createTextNode(
        "Plow's adversarial reviewer protects your data from malicious queries, while allowing your agents to get useful work done. ",
      ),
      el("strong", { text: "What access should it allow to your Mac?" }),
    ]),
  ]);
  const g = gatekeeper;
  if (!g || !gatekeeperPresets) return el("div", { class: "step-inner gatekeeper-screen" }, [head, note(state)]);

  // Each default replaces the text with its preset; it is an action, not a state.
  const defaults = el("div", { class: "gk-defaults" }, [
    el("span", { text: "Use a default:" }),
    button("Personal assistant", "gk-default", () => choosePreset("home")),
    button("Executive assistant", "gk-default", () => choosePreset("work")),
  ]);

  const field = el("textarea", {
    class: "gk-text",
    attrs: { rows: "3", spellcheck: "false", "aria-label": "What access should it allow to your Mac?" },
  });
  field.value = g.text;
  field.addEventListener("input", () => {
    g.text = field.value;
    // An edit retires the shown verdicts at once; only the review waits for a pause.
    if (g.text.trim() === g.lastText) return;
    invalidate(g, g.text);
    schedulePreview();
  });

  const rows = gatekeeperPresets[g.deck].rows.map(({ label, icon: glyph, command }, index) => {
    const end = el("span", { class: "gk-end" });
    const pill = el("button", { class: "gk-pill", attrs: { type: "button" } }, [
      icon(glyph, { strokeWidth: "1.7" }),
      el("span", { class: "gk-label", text: label }),
      end,
    ]);
    const flare = el("span", { class: "gk-flare" });
    const word = el("span", { class: "gk-word" });
    const reason = el("span");
    // The capability lines the reviewer reads, then what it made of them.
    const why = el("div", { class: "gk-why" }, [
      el("div", { class: "gk-detail" }, [
        el("div", { class: "gk-command" }, command.map((line) => el("div", { text: line }))),
        el("p", { class: "gk-verdict" }, [el("strong", { text: "Gatekeeper Verdict: " }), word, reason]),
      ]),
    ]);
    const node = el("div", { class: "gk-row" }, [el("div", { class: "gk-lane" }, [pill, flare]), why]);
    pill.addEventListener("click", () => {
      if (g.open.has(index)) g.open.delete(index);
      else g.open.add(index);
      node.classList.toggle("open", g.open.has(index));
      pill.setAttribute("aria-expanded", String(g.open.has(index)));
    });
    return { node, pill, end, word, reason, flare };
  });

  const mac = macMini();
  const beamField = el("div", { class: "gk-field" }, [
    mac,
    el("div", { class: "gk-beam", attrs: { "aria-hidden": "true" } }),
    el("div", { class: "gk-list" }, rows.map((r) => r.node)),
  ]);
  g.view = { field: beamField, rows, mac };
  rows.forEach((_, i) => paintRow(i));

  return el("div", { class: "step-inner gatekeeper-screen" }, [
    head,
    defaults,
    field,
    beamField,
    note(state),
  ]);
}

async function enterGatekeeper() {
  gatekeeperPresets ??= await window.domo.gatekeeperPresets();
  if (state?.step !== "gatekeeper" || !gatekeeperPresets) return;
  const deck = lastDeck = presetFor(state.purpose, gatekeeperPresets) ?? lastDeck ?? "home";
  gatekeeper = {
    deck,
    text: state.purpose,
    gen: 0,
    lastText: null,
    timer: null,
    view: null,
    open: new Set(),
    results: gatekeeperPresets[deck].rows.map(() => null),
  };
  render();
  runPreview();
}

function continueFromGatekeeper() {
  return update(() => window.domo.onboardingAdvance(gatekeeper?.text ?? state.purpose));
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
  } else {
    parts.push(el("p", { class: "state-note", text: "Getting a code from Plow…" }));
  }

  if (activation) {
    parts.push(el("div", { class: "waiting-status" }, [
      ...(state.activationStale ? [] : [el("span", { class: "waiting-spinner" })]),
      el("span", {
        class: "status-text",
        text: state.activationStale ? "Still not signed in" : "Waiting for your text…",
      }),
    ]));

    const countdown = el("p", { class: "countdown", attrs: { "aria-live": "off" } });
    if (!state.activationStale) startActivationCountdown(countdown, activation.pollUntil);
    parts.push(countdown);

    if (state.activationStale) {
      parts.push(el("div", { class: "inline-actions" }, [
        button("Try again", "link-button", () => update(() => window.domo.onboardingNewCode())),
      ]));
    }

    {
      const activate = button("", "verify-activate", async () => {
        activate.disabled = true;
        activate.classList.add("sending");
        await update(() => window.domo.onboardingOpenMessages());
      });
      activate.append(
        icon("messages", { strokeWidth: "1.7" }),
        document.createTextNode("Open Messages to activate"),
      );

      const actions = [activate];
      if (!state.activationStale) {
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

const onPluginStep = () => state?.step === "plugins" || state?.step === "access";

/** Every plugins answer — a refresh, a switch, a grant's act — lands here.
 * One older than an answer already shown is dropped (a focus refresh must not
 * undo a switch), and so is one that lands after setup left both steps. */
const showPlugins = latestOnly((next) => {
  if (!onPluginStep()) return;
  pluginsState = next;
  render();
});

async function refreshPlugins() {
  await showPlugins(() => window.domo.pluginsGet());
}

/** Access's one button: the list's flows in order; a grant that did not land
 * stops the run on its row. */
async function startGrants() {
  missed = null; // the run's first redraw must not still show the last miss
  missed = await runGrants({
    act: (id) => whenAnswered(window.domo.requirementsAct(id), showPlugins),
    getState: () => pluginsState,
    stillHere: () => state?.step === "access",
    setRunning: (id) => {
      running = id;
      render();
    },
  }, skipped);
  render();
}

async function refreshAvailability() {
  const [launch, awake] = await Promise.all([
    window.domo.launchGet(),
    window.domo.keepAwakeGet(),
  ]);
  availability = { launch, awake };
  if (state?.step !== "availability") return;
  if (syncAvailability) syncAvailability();
  else render();
}

/** One switch row: bold lead, plain detail, the switch on the right. */
function toggleRow(box, strong, detail, extra = []) {
  return el("div", { class: "toggle-row" }, [
    el("span", { class: "toggle-copy" }, [
      el("span", { class: "toggle-detail" }, [
        el("strong", { text: strong }),
        document.createTextNode(detail),
      ]),
      ...extra,
    ]),
    switchEl(box),
  ]);
}

function availabilityScreen() {
  const launchBox = el("input", {
    attrs: { id: "launch-toggle", type: "checkbox", "aria-label": "Open Plow Latch when you log in" },
  });
  const awakeBox = el("input", {
    attrs: { id: "awake-toggle", type: "checkbox", "aria-label": "Keep this Mac awake while plugged in" },
  });
  const launchNote = el("p", {
    class: "toggle-note",
    text: "Only the installed app can add itself as a login item, so this from-source run can't.",
  });
  const sync = () => {
    const ready = availability !== null;
    launchBox.disabled = !ready || !availability.launch.supported;
    launchBox.checked = ready && availability.launch.openAtLogin;
    launchNote.hidden = !ready || availability.launch.supported;
    awakeBox.disabled = !ready;
    awakeBox.checked = ready && availability.awake.enabled;
  };
  // The switch shows what the OS/disk then holds, not what was clicked.
  launchBox.addEventListener("change", async () => {
    availability = { ...availability, launch: await window.domo.launchSet(launchBox.checked) };
    sync();
  });
  awakeBox.addEventListener("change", async () => {
    availability = { ...availability, awake: await window.domo.keepAwakeSet(awakeBox.checked) };
    sync();
  });
  syncAvailability = sync;
  sync();

  return el("div", { class: "form-screen availability-screen" }, [
    el("div", { class: "step-inner" }, [
      el("div", { class: "head-center" }, [
        el("h1", { text: "Keep this Mac reachable" }),
        el("p", {
          class: "subhead",
          text: "Your agents work through this Mac. When it's off, asleep, or Plow Latch isn't running, they can't reach your email, calendar, messages, or browser.",
        }),
      ]),
      el("div", { class: "form-block" }, [
        toggleRow(
          launchBox,
          "Open Plow Latch when you log in. ",
          "A restart won't take this Mac off the roster.",
          [launchNote],
        ),
        toggleRow(
          awakeBox,
          "Keep this Mac awake while plugged in. ",
          "Prevents idle and display sleep on power. On battery it sleeps normally, and closing the lid still sleeps it.",
        ),
      ]),
    ]),
  ]);
}

function pluginRow(row) {
  const box = el("input", { attrs: { id: `plugin-${row.name}`, type: "checkbox", "aria-label": `Use ${row.title}` } });
  box.checked = row.status !== "off";
  box.addEventListener("change", async () => {
    restoreFocus = box.id;
    await showPlugins(() => window.domo.pluginsSetEnabled(row.name, box.checked));
  });
  const tags = row.status === "off"
    ? []
    : row.requirements
      .filter((req) => req.status !== "met")
      .map((req) => el("span", { class: "item-tag required", text: `Required: ${req.title}` }));
  return el("div", { class: `item-row${row.status === "off" ? " off" : ""}` }, [
    el("span", { class: "item-icon" }, [
      icon(row.kind === "Browser" ? "browser" : "command", { strokeWidth: "1.7" }),
    ]),
    el("span", { class: "item-copy" }, [
      el("span", { class: "item-name", text: row.title }),
      row.summary ? el("span", { class: "item-detail", text: row.summary }) : null,
      tags.length ? el("span", { class: "item-tags" }, tags) : null,
    ]),
    switchEl(box),
  ]);
}

function pluginsScreen() {
  const telemetry = el("input", {
    attrs: {
      id: "telemetry-toggle",
      type: "checkbox",
      "aria-label": "Share usage data",
    },
  });
  telemetry.checked = state.telemetryEnabled === true;
  telemetry.addEventListener("change", () => {
    restoreFocus = telemetry.id;
    void update(() => window.domo.onboardingSetTelemetry(telemetry.checked));
  });

  const parts = [
    el("div", { class: "head-center" }, [
      el("h1", { text: "Give your agents superpowers" }),
      el("p", {
        class: "subhead",
        text: "Plugins teach your agent how to reliably use your Mac",
      }),
      el("div", { class: "plugin-examples", attrs: { "aria-label": "Things you can ask" } }, [
        ["Gmail + Calendar", "Can you find three times that work and send them?"],
        ["iMessage history", "Do you see my thread with the contractor? Are we all paid up?"],
        ["Wiki", "What should I know before replying to this guest about the cabin?"],
        ["Browser", "How much is in my rental account—and did the tenants pay?"],
      ].map(([label, query]) => el("span", { class: "plugin-example" }, [
        el("small", { text: label }),
        el("span", { text: `“${query}”` }),
      ]))),
    ]),
  ];
  if (pluginsState) {
    parts.push(
      el("div", { class: "item-rows" }, pluginsState.rows.map(pluginRow)),
    );
  }
  parts.push(toggleRow(
    telemetry,
    "Share usage data so we can improve Plow. ",
    "Never your messages or your data.",
  ));
  // A local read failing has nothing busy about it — "Talking to Plow…" would
  // be wrong here, so only an actual error renders.
  if (state.message) parts.push(note(state));
  return el("div", { class: "form-screen" }, [el("div", { class: "step-inner" }, parts)]);
}

function statusLine(tone, text, lead = null) {
  return el("span", { class: `item-status ${tone}` }, [lead, el("span", { text })]);
}

/** One grant's row. Its words all come from the model — the renderer never
 * tells grants apart by id. A running flow has no Skip: the grant panel has
 * its own close, and closing it is a miss, which does. */
function grantRow(grant) {
  let tone = "";
  let line = null;
  let control = null;
  if (grant.status === "met") {
    control = el("span", { class: "item-chip" }, [
      icon("checkmark", { strokeWidth: "1.7" }),
      document.createTextNode(grant.done),
    ]);
    if (missed?.id === grant.id && missed.error) line = statusLine("error", missed.error);
  } else if (grant.status === "relaunch") {
    line = statusLine("done", "Granted: relaunch to finish");
  } else if (running === grant.id) {
    tone = " running";
    line = statusLine("live", grant.waiting, el("span", { class: "waiting-spinner" }));
  } else if (missed?.id === grant.id) {
    line = statusLine("error", missed.error || "That didn't finish, so nothing changed.");
    control = button("Skip", "link-button", () => {
      skipped.add(grant.id);
      void startGrants();
    });
  } else if (skipped.has(grant.id)) {
    line = statusLine("skipped", "Skipped. Finish anytime in Settings\u00a0›\u00a0Plugins.");
    control = button("Set up", "link-button", () => {
      skipped.delete(grant.id);
      render();
    });
  }
  return el("div", { class: `item-row${tone}` }, [
    el("span", { class: "item-icon" }, [icon("access", { strokeWidth: "1.7" })]),
    el("span", { class: "item-copy" }, [
      el("span", { class: "item-name", text: grant.title }),
      el("span", { class: "item-for", text: `For ${grant.plugins.join(" · ")}` }),
      el("span", { class: "item-detail", text: grant.detail }),
      line,
    ]),
    control ? el("span", { class: "item-control" }, [control]) : null,
  ]);
}

function accessScreen() {
  return el("div", { class: "form-screen" }, [
    el("div", { class: "step-inner" }, [
      el("div", { class: "head-center" }, [
        el("h1", { text: "Grant access" }),
        el("p", {
          class: "subhead",
          text: "One at a time. Skip anything and it'll wait for you in Settings\u00a0›\u00a0Plugins.",
        }),
      ]),
      el("div", { class: "item-rows" }, (pluginsState?.grants ?? []).map(grantRow)),
    ]),
  ]);
}

function doneScreen() {
  const importPasswords = button("Import passwords", "nav-next", () =>
    update(() => window.domo.onboardingFinish("import")));
  importPasswords.setAttribute("autofocus", "");
  const actions = [importPasswords];
  if (doneAgent) {
    actions.push(button(`Text ${doneAgent.name}`, "done-tertiary", async () => {
      await window.domo.cloudOpenMessages(doneAgent.agentId);
    }));
  }
  actions.push(button(
    "Not now",
    "done-tertiary",
    () => update(() => window.domo.onboardingFinish()),
  ));
  const outcomes = [
    ["banking", "Reconcile bank deposits and catch payment problems."],
    ["shopping", "Negotiate and verify an Amazon credit."],
    ["healthcare", "Arrange follow-up care through Kaiser."],
    ["travel", "Cancel Hipcamp bookings before their refund deadlines."],
  ];
  return el("div", { class: "done-wrap password-finish" }, [
    el("span", { class: "done-key" }, [icon("key", { strokeWidth: "1.8" })]),
    el("h1", { text: "Put your passwords to work" }),
    el("p", {
      class: "subhead",
      text: "Import passwords so your agents can securely sign in and get things done in your browser.",
    }),
    el("div", { class: "browser-outcomes" }, outcomes.map(([label, text]) =>
      el("div", { class: "browser-outcome" }, [
        el("span", { class: "outcome-dot", attrs: { "aria-hidden": "true" } }),
        el("span", {}, [el("small", { text: label }), el("span", { text })]),
      ]))),
    el("div", { class: "done-actions" }, actions),
  ]);
}

function screenForStep() {
  if (state.step === "welcome") return welcomeScreen();
  if (state.step === "privacy") return privacyScreen();
  if (state.step === "gatekeeper") return gatekeeperScreen();
  if (state.step === "activate" || state.step === "waiting") return verifyScreen();
  if (state.step === "plugins") return pluginsScreen();
  if (state.step === "access") return accessScreen();
  if (state.step === "availability") return availabilityScreen();
  if (state.step === "done") return doneScreen();
  return el("p", { class: "state-note error", text: "This setup step is unavailable." });
}

function footerForStep() {
  const step = state.step;
  const advance = () => update(() => window.domo.onboardingAdvance());
  if (step === "done") return { hidden: true };
  if (step === "welcome") {
    return {
      back: false,
      dot: null,
      label: "Get started",
      arrow: false,
      action: advance,
    };
  }
  if (step === "activate" || step === "waiting") {
    return { back: true, dot: 0, label: "Continue", arrow: true, disabled: true, action: null };
  }
  if (step === "privacy") {
    return {
      back: false,
      dot: 1,
      label: "Continue",
      arrow: true,
      action: advance,
    };
  }
  if (step === "gatekeeper") {
    return { back: false, dot: 2, label: "Continue", arrow: true, action: continueFromGatekeeper };
  }
  if (step === "access") {
    const { label, kind } = accessPrimary({ grants: pluginsState?.grants ?? [], skipped, running, missed });
    const actions = { run: startGrants, relaunch: () => window.domo.appRelaunch(), advance };
    return {
      back: true,
      dot: 4,
      label,
      arrow: kind !== null,
      disabled: kind === null || pluginsState === null,
      action: actions[kind] ?? null,
    };
  }
  if (step === "availability") {
    return {
      back: true,
      dot: 5,
      label: "Continue",
      arrow: true,
      action: advance,
    };
  }
  return {
    back: true,
    dot: 3,
    label: "Continue",
    arrow: true,
    action: advance,
  };
}

function playWelcomeEntrance() {
  const mark = screen.querySelector(".plw-mark");
  void startAfterDocumentPaint(() => {
    if (!mark.isConnected) return;
    if (typeof mark.getTotalLength === "function") {
      try {
        const length = Math.ceil(mark.getTotalLength());
        if (length > 0) screen.style.setProperty("--plw-len", length);
      } catch {
        // Layout-free test environments can lack SVG geometry. The CSS has a
        // conservative fallback length and the filled resting mark still shows.
      }
    }
    screen.classList.add("entering-full");
    document.body.classList.add("welcome-full");
  });
}

/** Redraw only the note of a screen that must not be rebuilt under the owner. */
function refreshNote(selector) {
  const wrap = screen.querySelector(selector);
  if (!wrap) return;
  wrap.querySelector(".state-note")?.remove();
  const next = note(state);
  if (next) wrap.append(next);
}

function render() {
  if (!state) return;
  clearInterval(expiryTimer);
  expiryTimer = null;
  if (state.step !== "plugins") restoreFocus = null;
  if (state.step !== "availability") syncAvailability = null;

  const continuingWelcome = state.step === "welcome" && screen.classList.contains("is-welcome");
  // The Gatekeeper is rebuilt only when it has no view (entering, a new deck):
  // a redraw would take the caret from the owner and replay every row.
  const continuingGatekeeper = state.step === "gatekeeper" && !!gatekeeper?.view;
  if (continuingWelcome) {
    refreshNote(".welcome-wrap");
  } else if (continuingGatekeeper) {
    refreshNote(".gatekeeper-screen");
  } else {
    // A redraw of the same step (a switch, a grant landing) keeps its scroll.
    const stepChanged = !screen.classList.contains(`is-${state.step}`);
    screen.className = `wizard-screen is-${state.step}`;
    screen.replaceChildren(screenForStep());
    if (stepChanged) body.scrollTop = 0;
    document.body.classList.remove("welcome-full");
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
    primaryButton.disabled = !!config.disabled || !!state.busy;
    primaryAction = config.action;
  } else {
    primaryAction = null;
  }

  if (state.step === "welcome" && !continuingWelcome) {
    playWelcomeEntrance();
  }

  const kept = restoreFocus ? document.getElementById(restoreFocus) : null;
  const focus = kept ?? screen.querySelector("[autofocus]")
    ?? (primaryButton.disabled ? screen.querySelector(".verify-activate:not(:disabled)") : null)
    ?? (!footer.hidden ? primaryButton : null);
  if (focus && !state.busy && !continuingGatekeeper) {
    requestAnimationFrame(() => {
      focus.focus({ preventScroll: true, focusVisible: false });
      if (focus === kept) restoreFocus = null;
    });
  }
  root.hidden = false;
}

async function apply(next) {
  const previousStep = state?.step;
  state = resolveOnboardingState(state, next);
  if (state?.step !== "gatekeeper" && gatekeeper) {
    clearTimeout(gatekeeper.timer);
    gatekeeper = null;
  }
  if (state?.step !== "done") doneAgent = null;
  if (!onPluginStep()) pluginsState = null;
  if (state?.step !== previousStep) missed = null;
  if (!onPluginStep() && state?.step !== "availability") skipped.clear();
  if (state?.step !== "availability") availability = null;
  render();
  if (state?.step === "gatekeeper" && previousStep !== "gatekeeper") void enterGatekeeper();
  if (onPluginStep() && previousStep !== state.step) void refreshPlugins();
  if (state?.step === "availability" && previousStep !== "availability") {
    void refreshAvailability();
  }
  if (state?.step === "done" && previousStep !== "done") {
    const loaded = await loadDoneAgent(() => window.domo.cloudAgents());
    if (state?.step !== "done") return;
    doneAgent = loaded;
    render();
  }
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.defaultPrevented || footer.hidden || primaryButton.disabled) return;
  if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLTextAreaElement) return;
  event.preventDefault();
  primaryButton.click();
});

window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  state = failedOnboardingState(state);
  render();
});

window.addEventListener("focus", () => {
  if (onPluginStep()) void refreshPlugins();
  if (state?.step === "availability") void refreshAvailability();
});

window.domo.onOnboardingChanged(async () => apply(await window.domo.onboardingGet()));
// Main's connector poll can land after the screen first loaded (a re-setup
// with Google already connected): redraw from the fresh accounts.
window.domo.onConnectorsChanged(() => {
  if (onPluginStep()) void refreshPlugins();
});
void window.domo.onboardingGet().then(apply);
