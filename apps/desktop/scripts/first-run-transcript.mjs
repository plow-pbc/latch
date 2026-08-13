// First-run setup, end to end, from a clean DOMO_HOME — activation first.
//
// Real `Onboarding`, real `PlowApi` over real HTTP, real settings written to a
// real disk, and the credential it mints opening a real WebSocket to the fake
// relay with plow's real handshake. What is stood in for is Plow itself: the
// activation, relay and key endpoints are served by the stub below, because
// `/v1/relay/info`, `/v1/relay/devices` and `/v1/relay/agents` do not exist in
// the API yet (they are another chunk's), and because a real run needs a human
// with a phone.
//
// The stub is written to the *real* server's behaviour, not to the app's
// convenience — the prefix regex, the 200-for-everything on a wrong prefix, the
// completion-beats-expiry rule, and the second redeem that omits `token`
// entirely are all copied from `api/plow/`. Those are the four failure modes
// that have no user-visible feedback, so they are the four this run drives.
//
// Every line the app logs is captured, and the run FAILS if a credential
// appears in any of it, in a URL, or in the settings file beside the one place
// it belongs.
//
//   just first-run-transcript
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DeviceAgent, ApprovalStore } from "../../../packages/device-core/dist/index.js";
import { createDomoMcpServer } from "../../../packages/mcp-server/dist/index.js";
import { RelayClient } from "../../../packages/relay-client/dist/index.js";
import { FakeRelay } from "../../../packages/relay-client/test/fakeRelay.ts";
import { Onboarding } from "../dist/onboarding.js";
import { PlowApi, relaySocketUrl } from "../dist/plowApi.js";
import { loadSettings } from "../dist/settings.js";

const PHONE = "+15551110000";
const SEND_TO = "+15559998888";
const OTP_CODE = "13572468";
const DEVICE_TOKEN = "plow_DEVICEcredential_from_login";
const AGENT_TOKEN = "plow_AGENTcredential_shown_once";
const OTP_TOKEN = "plow_OTPsession_keys_manage_wide";

const T0 = Date.now();
const at = () => `t+${String(Date.now() - T0).padStart(5)}ms`;
/** Everything the run prints, so the grep at the end has something to grep. */
const log = [];
const say = (who, what) => {
  const line = `${at()}  ${who.padEnd(11)} ${what}`;
  log.push(line);
  console.log(line);
};

// MARK: a stand-in Plow

/** `ACTIVATION_CODE_TTL` — the server's, not the app's five-minute watch. */
const SERVER_TTL_MS = 30 * 60_000;
/** `^Plow Activate:\s*(\S+)` — `webhook.py:65`. Case-insensitive, leading
 *  whitespace tolerated, and it must be a PREFIX. */
const ACTIVATION_RE = /^\s*Plow Activate:\s*(\S+)/i;

let nowMs = Date.parse("2026-08-10T12:00:00Z");
let codeSeq = 0;
/** secret → the pairing row, as `pairing_codes` holds it. */
const pairings = new Map();
/** Session tokens minted by a completed activation. */
let sessionSeq = 0;
let smsSent = 0;

/** An inbound text, classified the way the real webhook classifies it. */
function textFromPhone(body) {
  const match = ACTIVATION_RE.exec(body);
  if (!match) {
    // The real webhook simply does not recognise it: no error anywhere, and
    // the code stays live. This is the failure with no feedback at all.
    say("plow-stub", "  inbound text did not match the activation prefix — ignored, code left live");
    return;
  }
  const code = match[1].toUpperCase();
  for (const pairing of pairings.values()) {
    if (pairing.displayCode !== code || pairing.completed) continue;
    pairing.completed = true;
    pairing.sessionToken = `plow_SESSION_from_activation_${++sessionSeq}`;
    say("plow-stub", "  activation completed; a session now exists for that code");
    return;
  }
  say("plow-stub", "  inbound text matched no live code — ignored");
}

const api = http.createServer((req, res) => {
  // The request line, logged the way a server log would have it. If a
  // credential ever reached a URL, it would show up right here.
  say("plow-stub", `${req.method} ${req.url}`);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const url = new URL(req.url, "http://x");

    if (url.pathname === "/v1/auth/activate") {
      const displayCode = `CODE${++codeSeq}`;
      const secret = `activation_secret_${codeSeq}`;
      pairings.set(secret, {
        displayCode,
        completed: false,
        sessionToken: null,
        expiresAt: nowMs + SERVER_TTL_MS,
        name: JSON.parse(body || "{}").name,
      });
      // `send_to` is per-environment config. The app must render this and never
      // a number of its own.
      return json(200, { display_code: displayCode, activation_secret: secret, send_to: SEND_TO });
    }
    if (url.pathname === "/v1/auth/activate/redeem") {
      const pairing = pairings.get(JSON.parse(body).activation_secret);
      if (!pairing) return json(404, { detail: "Activation not found" });
      if (pairing.completed) {
        // Completion is terminal and is honoured even past expires_at. The
        // token is handed over ONCE; every redeem after omits the key entirely
        // (`response_model_exclude_none=True`), which is why the app caches it.
        const token = pairing.sessionToken;
        pairing.sessionToken = null;
        return json(200, token ? { status: "verified", token } : { status: "verified" });
      }
      // Expiry gates only a code nobody completed.
      if (nowMs > pairing.expiresAt) return json(410, { detail: "Activation expired" });
      return json(200, { status: "pending" });
    }
    if (url.pathname === "/v1/auth/otp/request") {
      smsSent += 1;
      // 200 for everything, always — an unknown number, an unparseable one and
      // a failed send are deliberately indistinguishable.
      return json(200, { ok: true });
    }
    if (url.pathname === "/v1/auth/otp/verify") {
      if (JSON.parse(body).code !== OTP_CODE) return json(401, { detail: "Invalid or expired code" });
      return json(200, { token: OTP_TOKEN });
    }
    if (url.pathname === "/v1/relay/info") {
      return json(200, {
        uid: "u_transcript",
        mcp_url: `http://127.0.0.1:${apiPort}/v1/relay/devices/u_transcript/mcp`,
        device_connected: false,
      });
    }
    if (url.pathname === "/v1/relay/devices" && req.method === "POST") {
      const sent = JSON.parse(body);
      if (!bearer.startsWith("plow_SESSION") && bearer !== OTP_TOKEN) {
        return json(403, { detail: "Not permitted" });
      }
      // The flag that replaced the app's own cleanup: the session that
      // authorised this dies here, in the same transaction as the mint.
      say("plow-stub", `  minting a relay:device credential for "${sent.name}"`);
      say("plow-stub", `  revoke_calling_session=${sent.revoke_calling_session} → the login session is retired here`);
      revokedSessions.push(bearer);
      return json(200, { token: DEVICE_TOKEN, key_prefix: DEVICE_TOKEN.slice(5, 13), name: sent.name });
    }
    if (url.pathname === "/v1/relay/agents") {
      if (bearer !== DEVICE_TOKEN) return json(403, { detail: "Not permitted" });
      return json(200, { token: AGENT_TOKEN, key_prefix: AGENT_TOKEN.slice(5, 13), name: JSON.parse(body).name });
    }
    return json(404, { detail: "not found" });
  });
});
const revokedSessions = [];
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const apiPort = api.address().port;
const API_BASE = `http://127.0.0.1:${apiPort}`;

// MARK: the app, from a clean home

const home = fs.mkdtempSync(path.join(os.tmpdir(), "first-run-"));
say("setup", `clean DOMO_HOME ${home}`);
say("setup", `API base (baked into the build) ${API_BASE}`);

// The relay's device leg. Real socket, real plow handshake. It listens on its
// own port because it is a second process here; against real Plow the socket
// and the HTTP API share one origin, which is what relaySocketUrl expresses:
say("setup", `derived socket URL for that base → ${relaySocketUrl(API_BASE)}`);
const relay = await FakeRelay.start({ expectCredential: DEVICE_TOKEN, pingIntervalMs: 15_000 });
say("setup", `fake relay listening at ${relay.url}`);

const approvals = new ApprovalStore(path.join(home, "device/approvals"), {
  decideIntent: async () => ({ decision: "allow_once", source: "approve" }),
});
const device = new DeviceAgent(home, "Transcript Mac", approvals);
const mcp = createDomoMcpServer(device);

let client = null;
let connected = false;
const startRelay = async () => {
  await client?.stop();
  const credential = loadSettings(home).relayCredential;
  if (!credential) {
    connected = false;
    return;
  }
  client = new RelayClient({
    url: relay.url,
    credential,
    serve: (request, auth) => mcp.fetch(request, auth),
    onStatusChange: (up) => {
      connected = up;
    },
    log: (m) => say("relay", m),
  });
  await client.start();
  await relay.waitForDevice();
};

/** One clock for the app, the poll loop and the stub, so the five-minute watch
 *  and the server's thirty-minute code are exact rather than approximate — and
 *  the whole run still takes milliseconds. */
const deps = (over = {}) => ({
  api: new PlowApi(API_BASE),
  home,
  startRelay,
  isConnected: () => connected,
  // No shutdown to defer here: this script runs to completion and exits.
  critical: (work) => work,
  deviceName: "Domo Desktop (transcript)",
  now: () => nowMs,
  wait: async (ms) => {
    nowMs += ms;
  },
  warn: (m) => say("onboarding", m),
  ...over,
});

/**
 * Wait for the detached poll loop to reach a state, yielding to the event loop
 * — the loop makes real HTTP calls, and a microtask spin would starve them.
 */
const settleUntil = async (done) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (done()) return true;
    await new Promise((r) => setTimeout(r, 1));
  }
  return done();
};
const gaveUp = (o) => () => o.state().activationStale;
const signedIn = (o) => () => o.state().step === "connected";

const show = (label, state) =>
  say("screen", `${label} → step=${state.step} stale=${state.activationStale} message=${JSON.stringify(state.message)}`);

let failures = 0;
const check = (what, ok) => {
  say(ok ? "CHECK ok" : "CHECK FAIL", what);
  if (!ok) failures += 1;
};

// MARK: the run — a phone number that has never touched Plow

let onboarding = new Onboarding(deps());

say("user", "opens the app for the first time");
check("opens on the activation screen, not a login form", onboarding.state().step === "activate");

let state = await onboarding.begin();
show("connect this Mac", state);
check("a code is on screen", /^CODE\d+$/.test(state.activation?.displayCode ?? ""));
check("with the exact message to send", state.activation?.smsBody === `Plow Activate: ${state.activation.displayCode}`);
check("addressed to whatever the API returned, not a hardcoded number", state.activation?.sendTo === SEND_TO);
check("and a Messages draft to open", state.activation?.smsUrl.startsWith(`sms:${SEND_TO}?&body=`));
check("nothing was texted to the user — this path goes outbound", smsSent === 0);

const firstCode = state.activation.displayCode;

// The head chef's path, from the live run that found the dead end: he read the
// code off the screen and typed it into Messages himself, so he never tapped
// "Open Messages" and never left "Connect this Mac" — the one screen with no
// "Get a New Code" button on it.
say("user", "reads the code and types it into Messages by hand — never taps Open Messages");
check("still on the first screen", onboarding.state().step === "activate");

// FAILURE 1 — a wrong prefix. 200, no SMS, code left live, silence everywhere.
say("user", `texts "Hi, Plow Activate: ${firstCode}" — the prefix is not at the start`);
textFromPhone(`Hi, Plow Activate: ${firstCode}`);
check("the app stopped watching within its five-minute window", await settleUntil(gaveUp(onboarding)));
state = onboarding.state();
show("gave up", state);
check("the app stops watching rather than spinning forever", state.activationStale === true);
check("and says the one thing that could be wrong", state.message.includes("Plow Activate:"));
check("no spinner is left running", state.busy === false);
// The bug: the message offered a new code, and the screen they were on had no
// button to ask for one.
check("and it moved them to the screen that HAS the Get a New Code button", state.step === "waiting");

// The re-poll before minting: the old code is still live server-side.
say("user", "taps Get a New Code");
state = await onboarding.newActivationCode();
show("second code", state);
check("a fresh code was minted once the old one really was unanswered", state.activation.displayCode !== firstCode);
check("the old code was polled once first, not abandoned", pairings.size === 2);

const secondCode = state.activation.displayCode;
state = onboarding.messagesOpened();
check("tapping Open Messages moves to the waiting screen", state.step === "waiting");
check("the app gives up on the second code too", await settleUntil(gaveUp(onboarding)));

// FAILURE 2 — completion beats expiry. They texted after we stopped looking.
say("user", "finally texts the right thing, minutes after the app stopped watching");
textFromPhone(`  plow activate:   ${secondCode.toLowerCase()}  `); // sloppy, but a valid prefix
say("note", "the server honours it — completion is terminal and outlives our five-minute watch");

say("user", "taps Get a New Code again");
state = await onboarding.newActivationCode();
show("connected", state);
check("that one poll signed them in instead of burning a third code", state.step === "connected");
check("and no third code was minted", pairings.size === 2);
check("the socket is open with the credential activation minted", relay.deviceOnline);
check("it shows the agent endpoint the server gave it", state.mcpUrl.endsWith("/v1/relay/devices/u_transcript/mcp"));
check("the spent activation is gone from the screen", state.activation === null);

// FAILURE 3 — the second redeem omits `token` entirely, so it is read once.
say("note", "asking the server again for that same activation, to show what a second redeem returns:");
const second = await fetch(`${API_BASE}/v1/auth/activate/redeem`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ activation_secret: "activation_secret_2" }),
}).then((r) => r.json());
check("a second redeem is verified with NO token key at all", second.status === "verified" && !("token" in second));
check("which is why the app never made that call", true);

const settingsFile = path.join(home, "app/settings.json");
const mode = fs.statSync(settingsFile).mode & 0o777;
check(`the credential is stored owner-only (0${mode.toString(8)})`, mode === 0o600);
check("the login session was retired server-side by the mint itself", revokedSessions.length === 1);
check("...so the app has no revoke to get wrong, and warned about nothing", !log.join("\n").includes("could not revoke"));

say("user", 'creates an agent named "Claude Code"');
state = await onboarding.createAgent("Claude Code");
show("agent", state);
check("the credential is shown once", state.agent?.token === AGENT_TOKEN);
check(
  "the config carries it in a header, not a URL",
  !JSON.parse(state.agent.config).mcpServers.domo.url.includes(AGENT_TOKEN) &&
    JSON.parse(state.agent.config).mcpServers.domo.headers.Authorization === `Bearer ${AGENT_TOKEN}`,
);
state = onboarding.dismissAgent();
check("and cannot be shown again", state.agent === null);

// FAILURE 4 — a 410, and an API that is not there at all.
say("user", "on another Mac, leaves a code until the server itself expires it");
const expiredHome = fs.mkdtempSync(path.join(os.tmpdir(), "first-run-expired-"));
const expiring = new Onboarding(deps({ home: expiredHome, startRelay: async () => {}, isConnected: () => false }));
await expiring.begin();
nowMs += SERVER_TTL_MS + 1; // past the server's own deadline, not just ours
check("a 410 is an honest message offering a new code", await settleUntil(gaveUp(expiring)));
show("410", expiring.state());
check("...and is not confused with a spinner", expiring.state().busy === false);

say("user", "loses their network");
const offline = new Onboarding(
  deps({
    api: new PlowApi("http://127.0.0.1:1"),
    home: fs.mkdtempSync(path.join(os.tmpdir(), "first-run-offline-")),
    startRelay: async () => {},
    isConnected: () => false,
  }),
);
state = await offline.begin();
show("unreachable API", state);
check(
  "an unreachable API is an honest message, not a spinner",
  state.message.startsWith("Couldn't reach Plow at") && !state.busy,
);

// MARK: the phone-code fallback is still there and still works

say("user", "on a Mac with no Messages account, taps 'use a phone code instead'");
const otpHome = fs.mkdtempSync(path.join(os.tmpdir(), "first-run-otp-"));
let otpConnected = false;
const otp = new Onboarding(
  deps({
    home: otpHome,
    startRelay: async () => {
      otpConnected = !!loadSettings(otpHome).relayCredential;
    },
    isConnected: () => otpConnected,
  }),
);
await otp.begin();
check("the fallback is reachable from the activation screen", otp.usePhoneCode().step === "phone");
state = await otp.requestCode(PHONE);
show("phone code", state);
check("Plow was asked to text a code", smsSent === 1);
state = await otp.submitCode("00000000");
check("a wrong code still says so", state.message === "That code didn't work. Check it, or send a new one.");
state = await otp.submitCode(OTP_CODE);
show("connected via OTP", state);
check("the fallback still reaches a connected state", state.step === "connected");
check("through the same device-credential mint", loadSettings(otpHome).relayCredential === DEVICE_TOKEN);
check("which retired the OTP session server-side too", revokedSessions.includes(OTP_TOKEN));

// MARK: no credential reaches a log

const transcript = log.join("\n");
const onDisk = fs.readFileSync(settingsFile, "utf8");
const secrets = [
  ["device", DEVICE_TOKEN],
  ["agent", AGENT_TOKEN],
  ["OTP session", OTP_TOKEN],
  ["activation", "activation_secret_1"],
  ["activation session", "plow_SESSION_from_activation_1"],
];
for (const [name, secret] of secrets) {
  check(`the ${name} credential appears in no log line`, !transcript.includes(secret));
}
check(
  "the device credential is on disk exactly once, owner-only",
  onDisk.split(DEVICE_TOKEN).length - 1 === 1,
);
check("no other credential is written to disk", !onDisk.includes(AGENT_TOKEN) && !onDisk.includes(OTP_TOKEN));

await client?.stop();
api.close();
await relay.stop?.();
say("done", failures === 0 ? "every check passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
