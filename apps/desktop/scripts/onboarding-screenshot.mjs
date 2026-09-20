// Render the real first-run setup window offscreen, with the real preload, and
// capture one PNG per screen. Copy assertions make a missing screen or stale
// sentence fail the command rather than producing misleading evidence.
//
//   just onboarding-screenshots         → /tmp/onboarding-*.png
//   OUT_DIR=/path just onboarding-screenshots
import { app, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onboardingFixtures } from "../src/renderer/onboarding-fixtures.js";
import { ONBOARDING_FAILURE_MESSAGE } from "../src/renderer/onboardingFallback.js";
import { FONT_WAIT_CEILING_MS } from "../src/renderer/welcomeEntrance.js";
import { clickText, failLoudly, shootScreens, shotWindow } from "./screenshot-harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");
const outDir = process.env.OUT_DIR ?? "/tmp";
const REARM_NOTE =
  "That code still works — send it exactly as shown and this screen will move on by itself.";

const fixtureScreens = onboardingFixtures(Date.now()).map((fixture) => ({
  ...fixture,
  expectFooter: fixture.state?.step !== "done",
  expectBack: fixture.state?.canGoBack === true,
}));
const welcomeFixture = fixtureScreens[0];
const SCREENS = [
  ...fixtureScreens,
  {
    ...welcomeFixture,
    name: "boot-null",
    state: null,
    expectFooter: true,
    expectBack: false,
  },
  {
    ...welcomeFixture,
    name: "boot-rejected",
    rejectOnboardingGet: true,
    expect: [...welcomeFixture.expect, ONBOARDING_FAILURE_MESSAGE],
  },
];
let currentFixture = SCREENS[0];
let current = currentFixture.state;
let newCodeRequests = 0;
let finishDestination = null;
let releaseInitialGet;
let markInitialGetStarted;
const initialGetStarted = new Promise((resolve) => {
  markInitialGetStarted = resolve;
});
let holdInitialGet = true;
ipcMain.handle("onboarding:get", async () => {
  if (holdInitialGet) {
    markInitialGetStarted();
    await new Promise((resolve) => {
      releaseInitialGet = resolve;
    });
    holdInitialGet = false;
  }
  if (currentFixture.rejectOnboardingGet) throw new Error("onboarding:get fixture failure");
  return current;
});
ipcMain.handle("onboarding:newCode", async () => {
  newCodeRequests += 1;
  current = {
    ...current,
    message: REARM_NOTE,
    noteKind: "neutral",
    activation: current.activation
      ? { ...current.activation, pollUntil: Date.now() + 5 * 60_000 }
      : null,
  };
  return current;
});
ipcMain.handle("onboarding:setTelemetry", async (_event, enabled) => {
  current = { ...current, telemetryEnabled: enabled === true };
  return current;
});
ipcMain.handle("onboarding:gatekeeperPresets", async () => currentFixture.gatekeeper?.presets ?? null);
// "pending" holds every row on Checking.
ipcMain.handle("onboarding:gatekeeperPreview", async (_event, _preset, index) => {
  const results = currentFixture.gatekeeper?.results;
  if (results === "pending" || !results) return new Promise(() => {});
  return results[index];
});
ipcMain.handle("onboarding:finish", async (_event, destination) => {
  finishDestination = destination ?? null;
});
let currentLaunch = { supported: true, openAtLogin: true };
let currentAwake = { enabled: true };
ipcMain.handle("launch:get", async () => currentLaunch);
ipcMain.handle("launch:set", async (_event, on) => {
  if (currentLaunch.supported) currentLaunch = { ...currentLaunch, openAtLogin: on === true };
  return currentLaunch;
});
ipcMain.handle("power:getKeepAwake", async () => currentAwake);
ipcMain.handle("power:setKeepAwake", async (_event, on) => {
  currentAwake = { enabled: on === true };
  return currentAwake;
});
ipcMain.handle("plugins:get", async () => {
  if (currentFixture.pluginsPending) return new Promise(() => {});
  return currentFixture.plugins;
});
ipcMain.handle("plugins:setEnabled", async () => currentFixture.plugins);
ipcMain.handle("requirements:act", async () => ({ ...currentFixture.plugins, error: null }));
ipcMain.handle("app:relaunch", async () => {});
ipcMain.handle("cloud:agents", async () => currentFixture.cloud);
ipcMain.handle("cloud:openMessages", async () => true);

const verifyRearmFixture = SCREENS.find((fixture) => fixture.name === "verify-rearm");
verifyRearmFixture.prepare = async (win) => {
  const requestsBefore = newCodeRequests;
  const displayCodeBefore = await win.webContents.executeJavaScript(
    `document.querySelector(".message-code")?.textContent.trim() ?? ""`,
  );
  await clickText(win, "Try again");
  const displayCodeAfter = await win.webContents.executeJavaScript(
    `document.querySelector(".message-code")?.textContent.trim() ?? ""`,
  );
  const neutralNote = await win.webContents.executeJavaScript(
    `document.querySelector(".state-note.neutral:not(.error)")?.textContent.trim() ?? ""`,
  );
  if (newCodeRequests !== requestsBefore + 1) {
    throw new Error("Try again did not request a re-arm");
  }
  if (!displayCodeBefore || displayCodeAfter !== displayCodeBefore) {
    throw new Error(`Try again changed the display code: ${displayCodeBefore} → ${displayCodeAfter}`);
  }
  if (neutralNote !== REARM_NOTE) throw new Error("The re-arm note was not rendered neutrally");
};
// A fixture's `click` opens that row's reason, the way the owner would.
for (const fixture of SCREENS.filter((f) => f.click)) {
  fixture.prepare = async (win) => {
    await clickText(win, fixture.click);
    await new Promise((resolve) => setTimeout(resolve, 500));
  };
}

const pluginQueries = [
  "Can you find three times that work and send them?",
  "Do you see my thread with the contractor? Are we all paid up?",
  "What should I know before replying to this guest about the cabin?",
  "How much is in my rental account—and did the tenants pay?",
];
const pluginsFreshFixture = SCREENS.find((fixture) => fixture.name === "plugins-fresh");
pluginsFreshFixture.prepare = async (win) => {
  const examples = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll(".plugin-example"), (node) => ({
    text: node.textContent,
    visible: getComputedStyle(node).visibility === "visible",
  }))`);
  if (examples.length !== pluginQueries.length ||
      pluginQueries.some((query) => !examples.some((example) => example.text.includes(query)))) {
    throw new Error("Plugin query carousel did not render all four examples");
  }
  if (examples.filter((example) => example.visible).length !== 1) {
    throw new Error("Plugin query carousel must expose exactly one example at a time");
  }
};

// The final page does not implement an importer of its own: its primary action
// must name the one-shot handoff that opens Browser Vault's existing sheet.
const doneAgentFixture = SCREENS.find((fixture) => fixture.name === "done-agent");
doneAgentFixture.prepare = async (win) => {
  finishDestination = null;
  const focused = await win.webContents.executeJavaScript(
    `document.activeElement?.textContent.trim() ?? ""`,
  );
  if (focused !== "Import passwords") {
    throw new Error(`Final page focused ${JSON.stringify(focused)}, not Import passwords`);
  }
  await clickText(win, "Import passwords");
  if (finishDestination !== "import") {
    throw new Error(`Import passwords handed off to ${String(finishDestination)}, not Browser Vault`);
  }
};

const doneBrowserOffFixture = SCREENS.find((fixture) => fixture.name === "done-browser-off");
doneBrowserOffFixture.prepare = async (win) => {
  finishDestination = null;
  await clickText(win, "Enable Browser & import passwords");
  if (finishDestination !== "enable-browser-and-import") {
    throw new Error(`Browser-off import handed off to ${String(finishDestination)}`);
  }
};

const doneBrowserLoadingFixture = SCREENS.find((fixture) => fixture.name === "done-browser-loading");
doneBrowserLoadingFixture.prepare = async (win) => {
  const disabled = await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll("button")).find((button) => button.textContent.trim() === "Import passwords")?.disabled`,
  );
  if (disabled !== true) throw new Error("Import passwords was enabled before Browser status resolved");
};

failLoudly();

app.whenReady().then(async () => {
  const win = shotWindow(dist, {
    width: 660,
    height: 840,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#111110",
  });
  const initialLoad = win.loadFile(path.join(dist, "renderer/onboarding.html"));
  await initialGetStarted;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const preRender = (await win.webContents.capturePage()).resize({ width: 660, height: 840 });
  fs.mkdirSync(outDir, { recursive: true });
  const preRenderOut = path.join(outDir, "onboarding-pre-render.png");
  fs.writeFileSync(preRenderOut, preRender.toPNG());
  const { width } = preRender.getSize();
  const bitmap = preRender.toBitmap({ scaleFactor: 1 });
  const colors = [[330, 22], [330, 400], [330, 800], [560, 800]].map(([x, y]) =>
    bitmap.subarray((y * width + x) * 4, (y * width + x + 1) * 4).toString("hex"));
  const missing = new Set(colors).size === 1
    ? []
    : [`shell painted before onboarding state arrived (${colors.join(", ")})`];
  console.log("SHOT:" + JSON.stringify({ screen: "pre-render", out: preRenderOut, missing }));
  if (missing.length) throw new Error(missing[0]);
  releaseInitialGet();
  await initialLoad;

  const failures = await shootScreens({
    win,
    outDir,
    prefix: "onboarding",
    screens: SCREENS,
    load: async (fixture) => {
      currentFixture = fixture;
      current = fixture.state;
      currentLaunch = fixture.launch ?? { supported: true, openAtLogin: true };
      currentAwake = fixture.awake ?? { enabled: true };
      await win.loadFile(path.join(dist, "renderer/onboarding.html"));
      // The full Welcome resolves its last delayed reveal at about 2.08s. Shoot
      // its resting state after the font and first-paint gate has also settled.
      // The Gatekeeper's pills cross the beam and bump back within about 1.5s.
      const settleMs = fixture.state?.step === "welcome" || fixture.state === null
        ? FONT_WAIT_CEILING_MS + 2200
        : fixture.state?.step === "gatekeeper" ? 1800 : 400;
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    },
  });
  app.exit(failures ? 1 : 0);
});
