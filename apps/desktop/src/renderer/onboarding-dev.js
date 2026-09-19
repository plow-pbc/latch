/* Static-browser provider for onboarding.html's real renderer. Fixture
   selection is the preview's navigation; production transitions stay in main. */

import { onboardingFixtures } from "./onboarding-fixtures.js";

const fixtures = onboardingFixtures(Date.now());
const fixturesByName = new Map(fixtures.map((fixture) => [fixture.name, fixture]));
const params = new URLSearchParams(window.location.search);
let initialGetDelayMs = Number(params.get("onboardingGetDelayMs")) || 0;
let selected = fixturesByName.get(params.get("state")) ?? fixtures[0];
let current = { ...selected.state };
let launch = selected.launch ?? { supported: true, openAtLogin: true };
let awake = selected.awake ?? { enabled: true };
let changed = null;

function publish(next) {
  current = { ...next };
  changed?.();
  return Promise.resolve(current);
}

const currentState = async () => current;
const onboardingGet = async () => {
  if (initialGetDelayMs > 0) {
    const delayMs = initialGetDelayMs;
    initialGetDelayMs = 0;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return current;
};
const plugins = async () => selected.plugins;

window.domo = {
  onboardingGet,
  onboardingBegin: currentState,
  onboardingAdvance: currentState,
  onboardingBack: currentState,
  onboardingPrepareRelaunch: currentState,
  onboardingOpenMessages: currentState,
  onboardingNewCode: currentState,
  onboardingSetTelemetry: async (enabled) =>
    publish({ ...current, telemetryEnabled: enabled === true }),
  gatekeeperPresets: async () => selected.gatekeeper?.presets ?? null,
  // "pending" holds every row on Checking.
  gatekeeperPreview: (_preset, index) => {
    const results = selected.gatekeeper?.results;
    if (results === "pending" || !results) return new Promise(() => {});
    return Promise.resolve(results[index]);
  },
  pluginsGet: plugins,
  pluginsSetEnabled: plugins,
  requirementsAct: async () => ({ ...selected.plugins, error: null }),
  appRelaunch: async () => {},
  onboardingFinish: currentState,
  launchGet: async () => launch,
  launchSet: async (on) => {
    if (launch.supported) launch = { ...launch, openAtLogin: on === true };
    return launch;
  },
  keepAwakeGet: async () => awake,
  keepAwakeSet: async (on) => {
    awake = { enabled: on === true };
    return awake;
  },
  cloudAgents: async () => selected.cloud,
  cloudOpenMessages: async () => true,
  onOnboardingChanged: (callback) => {
    changed = callback;
  },
  onConnectorsChanged: () => {},
};

const picker = document.getElementById("fixturePicker");
picker.hidden = params.get("capture") === "1";
for (const fixture of fixtures) {
  const option = document.createElement("option");
  option.value = fixture.name;
  option.textContent = fixture.name;
  option.selected = fixture.name === selected.name;
  picker.appendChild(option);
}
picker.addEventListener("change", () => {
  const url = new URL(window.location.href);
  url.searchParams.set("state", picker.value);
  window.location.assign(url);
});

await import("./onboarding.js");
