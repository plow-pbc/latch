// Render the real first-run setup window offscreen, with the real preload, and
// capture one PNG per screen. Copy assertions make a missing screen or stale
// sentence fail the command rather than producing misleading evidence.
//
//   just onboarding-screenshots         → /tmp/onboarding-*.png
//   OUT_DIR=/path just onboarding-screenshots
import { app, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { failLoudly, shootScreens, shotWindow } from "./screenshot-harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");
const outDir = process.env.OUT_DIR ?? "/tmp";

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
};

/** Each screen, with the text it must contain to count as rendered. */
const SCREENS = [
  {
    name: "welcome",
    state: { ...base, step: "welcome", phone: "" },
    expect: [
      "Presents",
      "Plow Latch",
      "The privacy and security layer for Plow",
      "nothing you don't want to share ever leaves your computer",
      "Get started",
    ],
    expectFocus: "Get started",
  },
  {
    name: "privacy",
    state: { ...base, step: "privacy", phone: "" },
    expect: [
      "Privacy",
      "It all stays on your Mac",
      "You decide what needs your okay",
      "A second AI has your back",
      "Never sold, never trained on",
      "Back",
      "Continue",
    ],
    expectFocus: "Continue",
  },
  {
    name: "verify",
    state: { ...base, step: "activate", phone: "", activation: ACTIVATION },
    expect: [
      "Verify your phone to connect this Mac",
      "Send the message below from the phone number you want to use with Plow",
      DISPLAY_CODE,
      `Plow Activate: ${DISPLAY_CODE}`,
      SEND_TO,
      "Keep this private",
      "Anyone who sends this code from their number can link it to this Plow account",
      "Waiting for your text",
      "Listening for 4:",
      "Open Messages",
      "Use a phone code instead",
    ],
    expectFocus: "Open Messages",
  },
  {
    name: "signed-out-revoke-warning",
    state: {
      ...base,
      step: "welcome",
      phone: "",
      message:
        "Signed out on this Mac. Plow could not be reached to revoke the session — revoke it in Plow's account settings.",
    },
    expect: [
      "Signed out on this Mac",
      "Plow could not be reached to revoke the session",
      "revoke it in Plow's account settings",
    ],
    expectFocus: "Get started",
  },
  {
    name: "waiting",
    state: { ...base, step: "waiting", phone: "", activation: ACTIVATION },
    expect: [
      "Verify your phone to connect this Mac",
      DISPLAY_CODE,
      `Plow Activate: ${DISPLAY_CODE}`,
      "Waiting for your text",
      "Listening for 4:",
      "Open Messages",
    ],
    expectFocus: "Open Messages",
  },
  {
    name: "waiting-gave-up",
    state: {
      ...base,
      step: "waiting",
      phone: "",
      activation: ACTIVATION,
      activationStale: true,
      message:
        "We haven't heard from your phone. Send the message exactly as shown — it has to start with “Plow Activate:” — or try again.",
    },
    expect: ["Still not signed in", "it has to start with", "Plow Activate:", "Try again"],
    expectFocus: "Open Messages",
  },
  {
    name: "phone",
    state: { ...base, step: "phone", phone: "" },
    expect: ["Sign in to Plow", "We'll text you a code", "Phone number", "Send code", "Back"],
    expectFocus: "+1 555 123 4567",
  },
  {
    name: "code",
    state: {
      ...base,
      step: "code",
      message: "Check your phone for an 8-digit code.",
      codeExpiresAt: Date.now() + 4 * 60_000 + 30_000,
    },
    expect: [
      "Check your phone",
      "If +1 555 123 4567 is on a Plow account",
      "Expires in 4:",
      "Change number",
      "Resend",
      "Sign in",
    ],
    expectFocus: "12345678",
  },
  {
    name: "data-shell",
    state: { ...base, step: "data", accountUid: "u_7Qk2p9", connected: true },
    expect: [
      "Your data & permissions",
      "Help make Plow better",
      "Full Disk Access",
      "Change any of these anytime in Settings",
      "Continue",
    ],
    expectFocus: "Continue",
  },
  {
    name: "done-shell",
    state: { ...base, step: "done", accountUid: "u_7Qk2p9", connected: true },
    expect: ["You're all set", "Explore the app"],
  },
];

let current = SCREENS[0].state;
ipcMain.handle("onboarding:get", async () => current);

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
      current = fixture.state;
      await win.loadFile(path.join(dist, "renderer/onboarding.html"));
      // The Welcome mark resolves its draw/fill/sheen sequence at 1.75s. Shoot
      // its resting state rather than a deliberately half-drawn frame.
      await new Promise((resolve) => setTimeout(resolve, fixture.name === "welcome" ? 1900 : 400));
    },
  });
  app.exit(failures ? 1 : 0);
});
