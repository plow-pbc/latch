/* Static-browser provider for onboarding.html's real renderer. Fixture
   selection is the preview's navigation; production transitions stay in main. */

import { onboardingFixtures } from "./onboarding-fixtures.js";

const fixtures = onboardingFixtures(Date.now());
const fixturesByName = new Map(fixtures.map((fixture) => [fixture.name, fixture]));
const params = new URLSearchParams(window.location.search);
let selected = fixturesByName.get(params.get("state")) ?? fixtures[0];
let current = { ...selected.state };
let fullDiskAccess = selected.fullDiskAccess === true;
let connectors = structuredClone(selected.connectors ?? {
  busy: false,
  error: null,
  note: null,
  google: { accounts: [], connecting: false },
});
let changed = null;
let connectorsChanged = null;

function publish(next) {
  current = { ...next };
  changed?.();
  return Promise.resolve(current);
}

const currentState = async () => current;
const currentConnectors = async () => connectors;

window.domo = {
  onboardingGet: currentState,
  onboardingBegin: currentState,
  onboardingAdvance: currentState,
  onboardingBack: currentState,
  onboardingOpenMessages: currentState,
  onboardingNewCode: currentState,
  onboardingSetTelemetry: async (enabled) =>
    publish({ ...current, telemetryEnabled: enabled === true }),
  capabilitiesGet: async () => ({ fullDiskAccess }),
  fullDiskGrantFlow: async () => {
    fullDiskAccess = true;
  },
  onboardingFinish: currentState,
  connectorsRefresh: currentConnectors,
  connectorsConnect: currentConnectors,
  connectorsDisconnect: async (_provider, account) => {
    connectors = {
      ...connectors,
      google: {
        ...connectors.google,
        accounts: connectors.google.accounts.filter((row) => row.email !== account),
      },
    };
    connectorsChanged?.(connectors);
    return connectors;
  },
  connectorsSetDefault: async (_provider, account) => {
    connectors = {
      ...connectors,
      google: {
        ...connectors.google,
        accounts: connectors.google.accounts.map((row) => ({
          ...row,
          isDefault: row.email === account,
        })),
      },
    };
    connectorsChanged?.(connectors);
    return connectors;
  },
  cloudAgents: async () => selected.cloud,
  cloudOpenMessages: async () => true,
  onOnboardingChanged: (callback) => {
    changed = callback;
  },
  onConnectorsChanged: (callback) => {
    connectorsChanged = callback;
  },
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
