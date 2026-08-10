// First-run login, end to end, from a clean DOMO_HOME.
//
// Real `Onboarding`, real `PlowApi` over real HTTP, real settings written to a
// real disk, and the credential it mints opening a real WebSocket to the fake
// relay with plow's real handshake. What is stood in for is Plow itself: the
// five endpoints are served by the stub below, because `/v1/relay/info` and
// `/v1/relay/agents` do not exist in the API yet (they are another chunk's).
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
const CODE = "13572468";
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

/** Rows in the account's key list, as `GET /v1/api-keys` returns them. */
let keys = [{ id: 7, key_prefix: OTP_TOKEN.slice(5, 13), name: "Account Portal" }];
let requestedFor = [];

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

    if (url.pathname === "/v1/auth/otp/request") {
      requestedFor.push(JSON.parse(body).phone);
      // 200 for everything, always — an unknown number, an unparseable one and
      // a failed send are deliberately indistinguishable.
      return json(200, { ok: true });
    }
    if (url.pathname === "/v1/auth/otp/verify") {
      const sent = JSON.parse(body);
      if (sent.code !== CODE) return json(401, { detail: "Invalid or expired code" });
      return json(200, { token: OTP_TOKEN });
    }
    if (url.pathname === "/v1/relay/info") {
      return json(200, {
        uid: "u_transcript",
        mcp_url: `http://127.0.0.1:${apiPort}/v1/relay/devices/u_transcript/mcp`,
        device_connected: false,
      });
    }
    if (url.pathname === "/v1/api-keys" && req.method === "POST") {
      const sent = JSON.parse(body);
      if (bearer !== OTP_TOKEN) return json(403, { detail: "Cannot grant that scope" });
      say("plow-stub", `  minting ${JSON.stringify(sent.scopes)} for "${sent.name}"`);
      keys.push({ id: 8, key_prefix: DEVICE_TOKEN.slice(5, 13), name: sent.name });
      return json(200, { token: DEVICE_TOKEN, key_prefix: DEVICE_TOKEN.slice(5, 13), name: sent.name });
    }
    if (url.pathname === "/v1/api-keys" && req.method === "GET") return json(200, keys);
    if (url.pathname.startsWith("/v1/api-keys/") && req.method === "DELETE") {
      // CAVEAT, stated where it can be seen: the real endpoint requires
      // `keys:manage` and refuses to revoke the caller's own session
      // (`api/plow/keys/router.py:69-78`). Neither the OTP session (self) nor
      // the device credential (`relay:device`) can therefore do this today, so
      // this branch implements the contract the app is written against, not
      // what production would answer. See the chunk report.
      const id = Number(url.pathname.split("/").pop());
      keys = keys.filter((k) => k.id !== id);
      return json(200, { status: "revoked", id });
    }
    if (url.pathname === "/v1/relay/agents") {
      if (bearer !== DEVICE_TOKEN) return json(403, { detail: "Not permitted" });
      return json(200, { token: AGENT_TOKEN, key_prefix: AGENT_TOKEN.slice(5, 13), name: JSON.parse(body).name });
    }
    return json(404, { detail: "not found" });
  });
});
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

let clock = Date.now();
const onboarding = new Onboarding({
  api: new PlowApi(API_BASE),
  home,
  startRelay,
  isConnected: () => connected,
  deviceName: "Domo Desktop (transcript)",
  now: () => clock,
  warn: (m) => say("onboarding", m),
});

const show = (label, state) =>
  say("screen", `${label} → step=${state.step} connected=${state.connected} message=${JSON.stringify(state.message)}`);

let failures = 0;
const check = (what, ok) => {
  say(ok ? "CHECK ok" : "CHECK FAIL", what);
  if (!ok) failures += 1;
};

// MARK: the run

say("user", "opens the app for the first time");
check("opens on the phone screen", onboarding.state().step === "phone");

say("user", `enters ${PHONE}`);
show("phone", await onboarding.requestCode(PHONE));

say("user", "mistypes the code");
let state = await onboarding.submitCode("00000000");
show("wrong code", state);
check("a wrong code says so", state.message === "That code didn't work. Check it, or send a new one.");

say("user", "walks away; the code expires");
clock += 5 * 60_000 + 1;
state = await onboarding.submitCode(CODE);
show("expired code", state);
check("an expired code is told apart from a wrong one", state.message === "That code has expired. Send a new one.");

say("user", "taps Resend");
state = await onboarding.resendCode();
show("resend", state);
check("resend asks again without claiming a send", state.message === "Asked Plow for a new code.");
check("two codes were requested", requestedFor.length === 2);

say("user", `enters ${CODE}`);
state = await onboarding.submitCode(CODE);
show("connected", state);
check("reaches a connected state", state.step === "connected" && state.connected === true);
check("shows the agent endpoint the server gave it", state.mcpUrl.endsWith("/v1/relay/devices/u_transcript/mcp"));
check("the socket is open with the credential login minted", relay.deviceOnline);

const settingsFile = path.join(home, "app/settings.json");
const mode = fs.statSync(settingsFile).mode & 0o777;
check(`the credential is stored owner-only (0${mode.toString(8)})`, mode === 0o600);
say("CAVEAT", "the next check passes against the contract, not against production:");
say("CAVEAT", "  DELETE /v1/api-keys/{id} needs keys:manage and refuses self-revoke");
say("CAVEAT", "  (api/plow/keys/router.py:69-78), so neither credential can do it today.");
check("the OTP session is gone from the key list", !keys.some((k) => k.id === 7));
check("this Mac's own credential survives", keys.some((k) => k.key_prefix === DEVICE_TOKEN.slice(5, 13)));

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

say("user", "loses their network");
api.close();
await client?.stop();
const offline = new Onboarding({
  api: new PlowApi("http://127.0.0.1:1"),
  home: fs.mkdtempSync(path.join(os.tmpdir(), "first-run-offline-")),
  startRelay: async () => {},
  isConnected: () => false,
  deviceName: "d",
  now: () => clock,
});
state = await offline.requestCode(PHONE);
show("unreachable API", state);
check("an unreachable API is an honest message, not a spinner", state.message.startsWith("Couldn't reach Plow at") && !state.busy);

// MARK: no credential reaches a log

const transcript = log.join("\n");
const onDisk = fs.readFileSync(settingsFile, "utf8");
for (const [name, secret] of [["device", DEVICE_TOKEN], ["agent", AGENT_TOKEN], ["OTP session", OTP_TOKEN]]) {
  check(`the ${name} credential appears in no log line`, !transcript.includes(secret));
}
check(
  "the device credential is on disk exactly once, owner-only",
  onDisk.split(DEVICE_TOKEN).length - 1 === 1,
);
check("no other credential is written to disk", !onDisk.includes(AGENT_TOKEN) && !onDisk.includes(OTP_TOKEN));

await relay.stop?.();
say("done", failures === 0 ? "every check passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
