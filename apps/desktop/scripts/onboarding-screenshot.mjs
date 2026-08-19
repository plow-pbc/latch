// Render the REAL first-run setup window offscreen, with the REAL preload, and
// capture one PNG per screen. Reproducible evidence rather than four images
// someone has to trust — and it EXITS NON-ZERO if a screen is missing the
// content it exists to show.
//
//   just onboarding-screenshots         → /tmp/onboarding-*.png
//   OUT_DIR=/path just onboarding-screenshots
//
// The main process owns the onboarding state machine and the window renders
// whatever `onboarding:get` returns, so stubbing that one handler is enough to
// drive every screen — the same trick approval-screenshot.mjs uses.
import { app, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { failLoudly, shootScreens, shotWindow } from "./screenshot-harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "../dist");
const outDir = process.env.OUT_DIR ?? "/tmp";

const MCP_URL = "https://api.plow.co/v1/relay/devices/u_7Qk2p9/mcp";

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
  activationStale: false,
  accountUid: "u_7Qk2p9",
  mcpUrl: MCP_URL,
  connected: true,
};

/** Before the account exists: no uid, no endpoint, no socket. */
const newUser = { ...base, accountUid: "", mcpUrl: "", connected: false };

/** Each screen, with the text it must contain to count as rendered. */
const SCREENS = [
  {
    name: "activate",
    state: { ...newUser, step: "activate", phone: "", activation: ACTIVATION },
    expect: [
      "Connect this Mac",
      DISPLAY_CODE,
      // Copy-exact, because a message that does not START with the prefix gets
      // a 200, no SMS, and total silence on both channels.
      `Plow Activate: ${DISPLAY_CODE}`,
      SEND_TO,
      // Whoever texts the code gets the account, and the server cannot tell.
      "This code is a credential",
      "don't share it or post a screenshot",
      "Open Messages…",
      "Use a phone code instead",
    ],
    // The blue button answers Return: nothing to type here, so it holds focus.
    expectFocus: "Open Messages",
  },
  {
    name: "waiting",
    state: { ...newUser, step: "waiting", phone: "", activation: ACTIVATION },
    expect: [
      "Waiting for your text",
      "Nothing to type",
      DISPLAY_CODE,
      `Plow Activate: ${DISPLAY_CODE}`,
      "Listening for 4:",
      "Get a New Code",
    ],
    expectFocus: "Get a New Code",
  },
  {
    name: "waiting-gave-up",
    state: {
      ...newUser,
      step: "waiting",
      phone: "",
      activation: ACTIVATION,
      activationStale: true,
      message:
        "We haven't heard from your phone. Send the message exactly as shown — it has to start with “Plow Activate:” — or get a new code.",
    },
    // The one failure the user gets no other signal about: a wrong prefix is
    // answered with silence on both channels.
    expect: ["Still nothing", "it has to start with", "Plow Activate:", "Get a New Code"],
    expectFocus: "Get a New Code",
  },
  {
    name: "phone",
    state: { ...newUser, step: "phone", phone: "" },
    // The lede has to promise a text, not claim one was sent.
    expect: ["Sign in to Plow", "We'll text you a code", "Send Code"],
    // A screen WITH a field focuses the field — its Enter handler submits.
    expectFocus: "+1 555 123 4567",
  },
  {
    name: "code",
    state: {
      ...newUser,
      step: "code",
      // The API answers the same for an unknown number, an unparseable one and
      // a failed send, so this screen may never say "we've sent you a code".
      message: "Check your phone for an 8-digit code.",
      codeExpiresAt: Date.now() + 4 * 60_000 + 30_000,
    },
    expect: ["Check your phone", "If +1 555 123 4567 is on a Plow account", "Expires in 4:", "Resend"],
    expectFocus: "12345678",
  },
  {
    // The end of the wizard, and the door into the app: past this button the
    // main window exists for the first time. Connecting an MCP client is NOT
    // here — it is per-client and repeatable, so it lives in the main window.
    name: "connected",
    state: { ...base, step: "connected" },
    expect: ["This Mac is connected", "u_7Qk2p9", "under Agents", "Continue"],
    expectFocus: "Continue",
  },
];

let current = SCREENS[0].state;
ipcMain.handle("onboarding:get", async () => current);
// The renderer boots through `begin` (which mints the activation code on a real
// first run); here it is the same stubbed state, so each screen renders as-is.
ipcMain.handle("onboarding:begin", async () => current);

// Without this a thrown write (a missing OUT_DIR, say) leaves the app running
// with no output and no exit code — a hang that reads like a broken screen.
failLoudly();

app.whenReady().then(async () => {
  const win = shotWindow(dist, { width: 460, height: 560 });
  const failures = await shootScreens({
    win,
    outDir,
    prefix: "onboarding",
    screens: SCREENS,
    // A reload re-runs the renderer's boot, which pulls the stubbed state.
    load: async (screen) => {
      current = screen.state;
      await win.loadFile(path.join(dist, "renderer/onboarding.html"));
      await new Promise((r) => setTimeout(r, 400));
    },
  });
  app.exit(failures ? 1 : 0);
});
