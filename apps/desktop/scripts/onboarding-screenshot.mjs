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
const REARM_NOTE =
  "That code still works — send it exactly as shown and this screen will move on by itself.";

const SCREENS = onboardingFixtures(Date.now());
let currentFixture = SCREENS[0];
let current = currentFixture.state;
let currentFullDiskAccess = false;
let newCodeRequests = 0;
ipcMain.handle("onboarding:get", async () => current);
ipcMain.handle("onboarding:welcomePublished", async () => {
  current = { ...current, welcomeEntrancePlayed: true };
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
ipcMain.handle("capabilities:get", async () => ({ fullDiskAccess: currentFullDiskAccess }));
ipcMain.handle("fullDisk:grantFlow", async () => {});
ipcMain.handle("onboarding:setTelemetry", async (_event, enabled) => {
  current = { ...current, telemetryEnabled: enabled === true };
  return current;
});
ipcMain.handle("onboarding:finish", async () => {});
ipcMain.handle("cloud:agents", async () => currentFixture.cloud);
ipcMain.handle("cloud:openMessages", async () => true);

const verifyRearmFixture = SCREENS.find((fixture) => fixture.name === "verify-rearm");
verifyRearmFixture.prepare = async (win) => {
  const requestsBefore = newCodeRequests;
  const displayCodeBefore = await win.webContents.executeJavaScript(
    `document.querySelector(".message-code")?.textContent.trim() ?? ""`,
  );
  await clickText(win, "Still waiting? Send it again");
  const displayCodeAfter = await win.webContents.executeJavaScript(
    `document.querySelector(".message-code")?.textContent.trim() ?? ""`,
  );
  const neutralNote = await win.webContents.executeJavaScript(
    `document.querySelector(".state-note.neutral:not(.error)")?.textContent.trim() ?? ""`,
  );
  if (newCodeRequests !== requestsBefore + 1) {
    throw new Error("Send it again did not request a re-arm");
  }
  if (!displayCodeBefore || displayCodeAfter !== displayCodeBefore) {
    throw new Error(`Send it again changed the display code: ${displayCodeBefore} → ${displayCodeAfter}`);
  }
  if (neutralNote !== REARM_NOTE) throw new Error("The re-arm note was not rendered neutrally");
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
      // The full Welcome resolves its last delayed reveal at about 2.08s. Shoot
      // its resting state rather than a deliberately half-revealed frame.
      const settleMs = fixture.name === "welcome"
        ? 2400
        : fixture.name === "welcome-repeat" ? 450 : 400;
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    },
  });
  app.exit(failures ? 1 : 0);
});
