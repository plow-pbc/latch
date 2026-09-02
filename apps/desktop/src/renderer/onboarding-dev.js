/* Static-browser fixture provider for onboarding.html's real renderer. It is
   deliberately kept outside the shipping bridge: production still receives
   one whole state from main and owns no renderer-side transition graph. */

const DISPLAY_CODE = "Z1SWY";
const SEND_TO = "+1 555 987 6543";
const ACTIVATION = {
  displayCode: DISPLAY_CODE,
  sendTo: SEND_TO,
  smsBody: `Plow Activate: ${DISPLAY_CODE}`,
  smsUrl: `sms:${SEND_TO}?&body=Plow%20Activate%3A%20${DISPLAY_CODE}`,
  pollUntil: Date.now() + 4 * 60_000 + 30_000,
};

const base = {
  step: "welcome",
  phone: "+1 555 123 4567",
  message: "",
  busy: false,
  codeExpiresAt: null,
  activation: null,
  chat: null,
  activationStale: false,
  accountUid: "",
  mcpUrl: "",
  connected: false,
  telemetryEnabled: true,
  fullDiskAccess: false,
  agent: null,
};

const fixtures = {
  welcome: { ...base, step: "welcome", phone: "" },
  privacy: { ...base, step: "privacy", phone: "" },
  verify: { ...base, step: "activate", phone: "", activation: ACTIVATION },
  verified: { ...base, step: "verified", phone: "", activation: ACTIVATION, connected: true },
  phone: { ...base, step: "phone", phone: "" },
  code: {
    ...base,
    step: "code",
    message: "Check your phone for an 8-digit code.",
    codeExpiresAt: Date.now() + 4 * 60_000 + 30_000,
  },
  "data-fda-off": {
    ...base,
    step: "data",
    accountUid: "u_7Qk2p9",
    connected: true,
  },
  "data-fda-on": {
    ...base,
    step: "data",
    accountUid: "u_7Qk2p9",
    connected: true,
    fullDiskAccess: true,
  },
  "done-agent": {
    ...base,
    step: "done",
    accountUid: "u_7Qk2p9",
    connected: true,
    agent: { name: "Elm", smsUrl: "sms:+15559876543" },
  },
  "done-noagent": {
    ...base,
    step: "done",
    accountUid: "u_7Qk2p9",
    connected: true,
  },
};

const fixtureKeys = Object.keys(fixtures);
const params = new URLSearchParams(window.location.search);
let fixtureKey = params.get("state");
if (!fixtureKeys.includes(fixtureKey)) fixtureKey = "welcome";
let current = { ...fixtures[fixtureKey] };
let changed = null;

function publish(next) {
  current = { ...next };
  changed?.();
  return Promise.resolve(current);
}

function activationState() {
  return { ...current, step: "activate", activation: ACTIVATION, activationStale: false };
}

window.domo = {
  onboardingGet: async () => current,
  onboardingBegin: async () => current,
  onboardingAdvance: async () => {
    if (current.step === "welcome") return publish({ ...current, step: "privacy" });
    if (current.step === "privacy") return publish(activationState());
    if (current.step === "verified") return publish({ ...current, step: "data", activation: null });
    if (current.step === "data") return publish({ ...current, step: "done" });
    return current;
  },
  onboardingBack: async () => {
    if (current.step === "privacy") return publish({ ...current, step: "welcome" });
    if (current.step === "activate" || current.step === "waiting") {
      return publish({ ...current, step: "privacy" });
    }
    if (current.step === "phone" || current.step === "code") return publish(activationState());
    return current;
  },
  onboardingOpenMessages: async () => publish({ ...current, step: "waiting" }),
  onboardingNewCode: async () => publish(activationState()),
  onboardingUsePhoneCode: async () => publish({ ...current, step: "phone" }),
  onboardingUseActivation: async () => publish(activationState()),
  onboardingRequestCode: async (phone) => publish({
    ...current,
    step: "code",
    phone,
    codeExpiresAt: Date.now() + 5 * 60_000,
  }),
  onboardingResendCode: async () => publish({ ...current, codeExpiresAt: Date.now() + 5 * 60_000 }),
  onboardingEditPhone: async () => publish({ ...current, step: "phone" }),
  onboardingSubmitCode: async () => publish({
    ...current,
    step: "verified",
    message: "",
    codeExpiresAt: null,
    connected: true,
  }),
  onboardingSetTelemetry: async (enabled) => publish({ ...current, telemetryEnabled: enabled }),
  onboardingFinish: async () => current,
  onboardingMessageAgent: async () => current,
  onOnboardingChanged: (callback) => {
    changed = callback;
  },
};

const picker = document.getElementById("fixturePicker");
picker.hidden = params.get("capture") === "1";
for (const key of fixtureKeys) {
  const option = document.createElement("option");
  option.value = key;
  option.textContent = key;
  option.selected = key === fixtureKey;
  picker.appendChild(option);
}
picker.addEventListener("change", () => {
  fixtureKey = picker.value;
  const url = new URL(window.location.href);
  url.searchParams.set("state", fixtureKey);
  window.history.replaceState(null, "", url);
  publish(fixtures[fixtureKey]);
});

await import("./onboarding.js");
