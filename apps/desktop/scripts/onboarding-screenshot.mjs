// Render the real first-run setup window offscreen, with the real preload, and
// capture one PNG per screen. Copy assertions make a missing screen or stale
// sentence fail the command rather than producing misleading evidence.
//
//   just onboarding-screenshots         → /tmp/onboarding-*.png
//   OUT_DIR=/path just onboarding-screenshots
import { app, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onboardingFixtures } from "../src/renderer/onboarding-fixtures.js";
import { clickText, failLoudly, shootScreens, shotWindow } from "./screenshot-harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");
const outDir = process.env.OUT_DIR ?? "/tmp";

const SCREENS = onboardingFixtures(Date.now());
let currentFixture = SCREENS[0];
let current = currentFixture.state;
let currentFullDiskAccess = false;
let newCodeRequests = 0;
ipcMain.handle("onboarding:get", async () => current);
ipcMain.handle("onboarding:newCode", async () => {
  newCodeRequests += 1;
  return current;
});
ipcMain.handle("capabilities:get", async () => ({ fullDiskAccess: currentFullDiskAccess }));
ipcMain.handle("fullDisk:grantFlow", async () => {});
ipcMain.handle("onboarding:setTelemetry", async (_event, enabled) => {
  current = { ...current, telemetryEnabled: enabled === true };
  return current;
});
ipcMain.handle("onboarding:finish", async () => {});
ipcMain.handle("cloud:refresh", async () => currentFixture.cloud);
ipcMain.handle("cloud:openMessages", async () => true);

const verifyFixture = SCREENS.find((fixture) => fixture.name === "verify");
verifyFixture.after = async (win) => {
  const before = newCodeRequests;
  await clickText(win, "Get a new code");
  if (newCodeRequests !== before + 1) throw new Error("Get a new code did not request a re-mint");
};

failLoudly();

app.whenReady().then(async () => {
  const win = shotWindow(dist, {
    width: 660,
    height: 840,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#111110",
  });
  const failures = await shootScreens({
    win,
    outDir,
    prefix: "onboarding",
    screens: SCREENS,
    load: async (fixture) => {
      currentFixture = fixture;
      current = fixture.state;
      currentFullDiskAccess = fixture.fullDiskAccess === true;
      await win.loadFile(path.join(dist, "renderer/onboarding.html"));
      // The Welcome mark resolves its draw/fill/sheen sequence at 1.75s. Shoot
      // its resting state rather than a deliberately half-drawn frame.
      await new Promise((resolve) => setTimeout(resolve, fixture.name === "welcome" ? 1900 : 400));
    },
  });
  app.exit(failures ? 1 : 0);
});
