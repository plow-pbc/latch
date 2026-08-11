/**
 * The relay + MCP end-to-end gate.
 *
 *   just relay-gate
 *
 * One command, pass/fail, against a live Plow API + linq twin. Every credential
 * in the run is minted BY the run — phone OTP through the twin, then the device
 * key, then the agent key — because both scope bugs we shipped lived in exactly
 * the code a fixture token skips.
 *
 * The device end is a plain Node process: `DeviceAgent` + `createDomoMcpServer`
 * + `RelayClient`, no Electron. It runs in this process so a test can count
 * executions on the device side, which is what the reroute case turns on.
 *
 * The agent end is the same minimal MCP 2026-07-28 envelope as
 * packages/mcp-server/test/client.ts, pointed at the URL and headers the API
 * handed back in `mcp_config` — read out of that blob, never hand-assembled.
 * That blob is the product; a harness that builds its own URL passes while the
 * config we hand users stays broken.
 */
import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeviceAgent, PolicyDelegate } from "@domo/device-core";
import { Intent } from "@domo/protocol";
import { createDomoMcpServer, DomoMcpServer, PROTOCOL_REVISION } from "@domo/mcp-server";
import { RelayClient } from "@domo/relay-client";

// ---------------------------------------------------------------------------
// Configuration. Defaults are the relay-prb variant stack (just api up there).
// ---------------------------------------------------------------------------

const API = process.env.RELAY_GATE_API ?? "http://127.0.0.1:19264";
const TWIN = process.env.RELAY_GATE_TWIN ?? "http://127.0.0.1:19265";
const WS_URL = (process.env.RELAY_GATE_WS ?? API.replace(/^http/, "ws")) + "/v1/relay/ws";

/** The call budget this device serves under. Small so the deferred case does
 * not take a minute; everything else finishes far inside it. */
const BUDGET_MS = 3_000;

/** MCP revisions this server must refuse, per the settled facts. */
const BAD_REVISIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2099-01-01"];

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Where the run drops its nonce for the Mac to read back.
 *
 * FIXED, and the argv that reads it is fixed too, because the always-allow rule
 * key is SHA-256 over agent + device + NORMALIZED CAPABILITIES — and
 * `normalizedCapability` keeps `argv` and `cwd` verbatim (only `reason` is
 * dropped; paths are canonicalized and sorted). A nonce inside argv would
 * change the key on every call, so every call would re-prompt and no Always
 * Allow could ever cover the next one. Varying the file's CONTENT instead
 * keeps the capability — and therefore the rule — identical, while the proof
 * stays per-run.
 *
 * The physical path is used as-is: canonicalize() resolves /tmp to /private/tmp
 * via realpath, so writing the physical form keeps the rule key stable.
 */
const NONCE_DIR = "/private/tmp/relay-gate";
const NONCE_FILE = `${NONCE_DIR}/nonce.txt`;

/** The one command this gate ever runs on the Mac. Read-only, and constant. */
const NONCE_ARGV = ["/bin/sh", "-c", `cat ${NONCE_FILE}; hostname`];

/**
 * `RELAY_GATE_DEVICE=external` — the acceptance leg.
 *
 * The device end is the real Electron app instead of this process, so the run
 * seeds the credential the app reads at boot, waits for the socket to come up,
 * and then does the six-step chain up to the nonce round trip. The negatives
 * stay out of this mode: they count executions inside this process, and two of
 * them deliberately kill the device socket — not something to do to an app a
 * human is watching. Headless (the default) is still the gate.
 */
const EXTERNAL_DEVICE = process.env.RELAY_GATE_DEVICE === "external";

/**
 * The app home the acceptance run seeds — DELIBERATELY NOT `~/.domo`, and
 * never `~/.domo-relay-public`.
 *
 * Those are live app instances: `~/.domo-relay-public` is the head chef's,
 * running against https://plow-api.plucas.dev on his own credential. Writing
 * `relayCredential` into either replaces the session he is using, and the
 * settings.json backup this harness takes does not undo an app that has
 * already read the new value and re-registered. So the acceptance run gets its
 * own home, and the app under test must be launched with the SAME
 * `DOMO_HOME` — otherwise it dials with whatever credential its own home holds
 * and the run is measuring someone else's device.
 */
const DEFAULT_GATE_HOME = path.join(os.homedir(), ".domo-relay-gate");
const DOMO_HOME = process.env.RELAY_GATE_DOMO_HOME ?? DEFAULT_GATE_HOME;

/** Homes this harness refuses to write to, whatever it is told. */
const PROTECTED_HOMES = new Set(
  [".domo", ".domo-relay-public"].map((name) => path.join(os.homedir(), name)),
);

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

let failures = 0;
let step = 0;

/**
 * A live Plow credential must never reach a transcript — these get pasted into
 * reports and pull requests. Every line goes through here, so this is the one
 * place that has to hold. `plow_` + `secrets.token_urlsafe` (A-Za-z0-9_-) is
 * the shape the API mints; the checks below print `key_prefix` and scopes
 * instead, and this catches anything that slips past them.
 */
function redactCredentials(message: string): string {
  return message.replace(/plow_[A-Za-z0-9_-]{12,}/g, "plow_<redacted>");
}

function say(message: string): void {
  process.stdout.write(`${redactCredentials(message)}\n`);
}

function heading(title: string): void {
  step += 1;
  say(`\n── ${step}. ${title}`);
}

function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  say(`   ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** A dependency is missing. Say which, and how to start it, rather than hang. */
function missing(what: string, how: string): never {
  say(`\nrelay gate: ${what}`);
  say(`relay gate: ${how}`);
  process.exit(2);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Plain HTTP against the API and the twin
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  text: string;
  json: any;
}

async function http(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<HttpResult> {
  const { timeoutMs = 30_000, ...rest } = init;
  const response = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not every body is JSON — status is what most negatives assert */
  }
  return { status: response.status, text, json: parsed };
}

const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  http(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// Step 0 — preflight. Named failures, never a hang.
// ---------------------------------------------------------------------------

async function preflight(): Promise<void> {
  heading("preflight");
  try {
    const health = await http(`${API}/health`, { timeoutMs: 4_000 });
    if (health.status !== 200) throw new Error(`status ${health.status}`);
  } catch (error: unknown) {
    missing(
      `the Plow API is not answering at ${API} (${String(error)})`,
      "start it: cd <plow worktree>/api && just up   (or set RELAY_GATE_API)",
    );
  }
  try {
    const health = await http(`${TWIN}/health`, { timeoutMs: 4_000 });
    if (health.status !== 200) throw new Error(`status ${health.status}`);
  } catch (error: unknown) {
    missing(
      `the linq twin is not answering at ${TWIN} (${String(error)})`,
      "it comes up with the same stack: just up starts dtu-linq   (or set RELAY_GATE_TWIN)",
    );
  }
  check("API and linq twin are up", true, `${API} · ${TWIN}`);
}

// ---------------------------------------------------------------------------
// Step 1 — a real account, and a portal session minted by a real OTP.
// ---------------------------------------------------------------------------

/** Activate a fresh account by texting the code back through the twin, exactly
 * as a human with the Mac app would. */
async function activate(phone: string, name: string): Promise<void> {
  const created = await postJson(`${API}/v1/auth/activate`, { name });
  assert.equal(created.status, 200, `POST /v1/auth/activate → ${created.status}: ${created.text}`);
  const { display_code, activation_secret, send_to } = created.json;

  const sent = await postJson(`${TWIN}/ui/inbound`, {
    text: `Plow Activate: ${display_code}`,
    remote_phone: phone,
    to_phone: send_to,
  });
  assert.equal(sent.status, 200, `twin /ui/inbound → ${sent.status}: ${sent.text}`);

  for (let i = 0; i < 20; i += 1) {
    const redeemed = await postJson(`${API}/v1/auth/activate/redeem`, {
      activation_secret,
    });
    if (redeemed.json?.status === "verified") return;
    await sleep(500);
  }
  throw new Error(`activation never verified for ${phone}`);
}

/** The OTP the API texted this phone, read out of the twin's inbox. */
async function readOtp(phone: string): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    const chats = await http(`${TWIN}/ui/chats`);
    const chat = (chats.json?.chats ?? []).find((c: any) => c.remote_phone === phone);
    const text: string = chat?.last_message?.parts?.[0]?.value ?? "";
    const match = /Your Plow login code: (\d+)/.exec(text);
    if (match) return match[1];
    await sleep(500);
  }
  throw new Error(`no login code arrived for ${phone}`);
}

/** Phone OTP through the twin → a portal session token. */
async function portalSession(phone: string, name: string): Promise<string> {
  await activate(phone, name);
  const requested = await postJson(`${API}/v1/auth/otp/request`, { phone });
  assert.equal(requested.status, 200, `otp/request → ${requested.status}`);
  const code = await readOtp(phone);
  const verified = await postJson(`${API}/v1/auth/otp/verify`, { phone, code });
  assert.equal(verified.status, 200, `otp/verify → ${verified.status}: ${verified.text}`);
  return verified.json.token as string;
}

// ---------------------------------------------------------------------------
// The device end — headless, and counting what it executed.
// ---------------------------------------------------------------------------

interface Device {
  /** Every intent this Mac was asked to decide — one entry per execution. */
  readonly decided: string[];
  /** Every tunnelled request body this Mac was handed — one per delivery. */
  readonly served: string[];
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** A second socket on the same credential — a reconnecting Mac. */
  reconnect(): Promise<void>;
  home: string;
}

function startDevice(credential: string): Device {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-gate-device-"));
  const decided: string[] = [];
  const served: string[] = [];

  // The sanctioned headless approval path: a PolicyDelegate that answers.
  // Nothing here bypasses the approval layer — it IS the approver, and every
  // decision it makes is recorded above and in the device's audit log.
  const policy: PolicyDelegate = {
    async decideIntent(intent: Intent) {
      decided.push(intent.request);
      return "allow_once";
    },
  };

  const device = new DeviceAgent(home, "relay gate mac", policy);
  const server: DomoMcpServer = createDomoMcpServer(device, { budgetMs: BUDGET_MS });

  const make = () =>
    new RelayClient({
      url: WS_URL,
      credential,
      serve: async (request, auth) => {
        const body = await request.clone().text();
        served.push(body);
        return server.fetch(request, auth);
      },
      log: () => {},
    });

  // Every client this device has dialled with. A replaced one keeps its own
  // reconnect loop running, so the offline case has to stop all of them —
  // stopping only the newest leaves the evicted one dialling back in.
  const clients: RelayClient[] = [];
  let client = make();
  clients.push(client);
  let connected = connectedPromise(client);

  function connectedPromise(c: RelayClient): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (c.isConnected) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() - started > 15_000) {
          clearInterval(poll);
          reject(new Error(`device never reached auth.ok on ${WS_URL}`));
        }
      }, 50);
      poll.unref?.();
    });
  }

  return {
    decided,
    served,
    home,
    async connect() {
      await client.start();
      await connected;
    },
    async disconnect() {
      await Promise.all(clients.map((c) => c.stop()));
    },
    async reconnect() {
      const previous = client;
      client = make();
      clients.push(client);
      connected = connectedPromise(client);
      await client.start();
      await connected;
      // The relay evicted the previous socket the moment the new one
      // registered. Retire that client so its backoff loop does not dial back
      // in and evict the replacement in turn. Not awaited: stop() waits for
      // the request still being served on it, which is the whole point of
      // this case.
      void previous.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// The agent end — MCP 2026-07-28, over the config the API handed out.
// ---------------------------------------------------------------------------

interface McpTarget {
  url: string;
  headers: Record<string, string>;
}

/**
 * What a successful mint may say out loud: the prefix that identifies the
 * credential in the sessions list, its scopes, and its name. Never the token.
 * A FAILED mint dumps its body, because a failure body carries no credential
 * and is the only thing that explains the failure.
 */
function mintDetail(result: HttpResult): string {
  if (result.status !== 200) return `status ${result.status}: ${result.text.slice(0, 200)}`;
  const { key_prefix, scopes, name } = result.json ?? {};
  return `key_prefix ${key_prefix} · scopes ${JSON.stringify(scopes)} · name ${JSON.stringify(name)}`;
}

/** Read the URL and headers out of `mcp_config` verbatim. Never assembled. */
function targetFromConfig(mcpConfig: string): McpTarget {
  const parsed = JSON.parse(mcpConfig);
  const entry = parsed?.mcpServers?.plow;
  assert.ok(entry, `mcp_config has no mcpServers.plow: ${mcpConfig}`);
  assert.equal(entry.type, "http", `mcp_config type is ${entry.type}`);
  return { url: entry.url as string, headers: entry.headers as Record<string, string> };
}

let nextId = 1;

/** POST one JSON-RPC request through the relay to the Mac. */
async function rpc(
  target: McpTarget,
  method: string,
  params: Record<string, unknown> = {},
  overrides: {
    protocolVersion?: string;
    headers?: Record<string, string>;
    url?: string;
    rawBody?: string;
  } = {},
): Promise<HttpResult> {
  const revision = overrides.protocolVersion ?? PROTOCOL_REVISION;
  const body =
    overrides.rawBody ??
    JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": revision,
          "io.modelcontextprotocol/clientInfo": { name: "relay-gate", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
  return http(overrides.url ?? target.url, {
    method: "POST",
    headers: {
      ...target.headers, // the credential, exactly as mcp_config carries it
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": revision,
      "mcp-method": method,
      ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
      ...overrides.headers,
    },
    body,
  });
}

/** The JSON payload a tool produced, plus its error flag. */
function toolPayload(raw: HttpResult): { payload: any; isError: boolean } {
  const text = raw.json?.result?.content?.[0]?.text;
  if (text === undefined) return { payload: raw.json, isError: raw.json?.error !== undefined };
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { error: text };
  }
  return { payload, isError: raw.json?.result?.isError === true };
}

const callTool = (target: McpTarget, name: string, args: Record<string, unknown>) =>
  rpc(target, "tools/call", { name, arguments: args });

/**
 * Wait for a just-minted credential to be usable.
 *
 * `get_db` commits in the dependency's teardown, which FastAPI runs AFTER the
 * response has gone out — so `POST /v1/relay/agents` hands back a token that
 * can still 401 for a few milliseconds. Nothing downstream of this is testing
 * commit timing, so the gate waits rather than flaking on it. The race itself
 * is a finding, and is in the report.
 */
async function settle(target: McpTarget): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const probe = await rpc(target, "tools/list");
    if (probe.status !== 401) return;
    await sleep(100);
  }
  throw new Error(`a freshly minted credential never became usable: ${target.url}`);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Hand the device credential to the real app the way the app expects it:
 * `relayCredential` in ${DOMO_HOME}/app/settings.json, 0600. With it present
 * at launch the app skips onboarding and dials at boot. The API origin is the
 * app's own `DOMO_API_BASE_URL`; it derives the socket from that by swapping
 * http→ws and appending /v1/relay/ws, so the two must be the same origin —
 * verified in apps/desktop/src/plowApi.ts (`relaySocketUrl`), and the env
 * override wins in packaged builds too (`resolveApiBaseUrl`).
 */
function seedRealApp(credential: string, uid: string, mcpUrl: string): string {
  const home = path.resolve(DOMO_HOME);
  if (PROTECTED_HOMES.has(home)) {
    missing(
      `refusing to seed a live app home: ${home}`,
      "point RELAY_GATE_DOMO_HOME somewhere of its own (default ~/.domo-relay-gate) and launch the app with DOMO_HOME set to the same path",
    );
  }
  const file = path.join(home, "app", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.relay-gate-backup`);
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* an unreadable settings file is replaced, and the backup is beside it */
    }
  }
  settings.relayCredential = credential;
  settings.accountUid = uid; // display-only, per the app
  settings.mcpUrl = mcpUrl; // display-only
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

async function main(): Promise<void> {
  const runId = crypto.randomUUID().slice(0, 8);
  // Distinct phones per run so a re-run is a fresh account, not a reused one.
  const phoneA = `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  const phoneB = `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;

  say(`relay gate ${runId} — API ${API}, device socket ${WS_URL}`);
  await preflight();

  heading("OTP through the twin → portal session");
  const portalA = await portalSession(phoneA, "relay gate A");
  check("account A holds a portal session", portalA.startsWith("plow_"), `phone ${phoneA}`);

  heading("POST /v1/relay/devices → a device credential, and nothing wider");
  const minted = await postJson(
    `${API}/v1/relay/devices`,
    { name: `relay gate ${runId}`, revoke_calling_session: false },
    { Authorization: `Bearer ${portalA}` },
  );
  check("mint returns 200", minted.status === 200, mintDetail(minted));
  const deviceToken: string = minted.json.token;
  check(
    "scope is exactly relay:device",
    JSON.stringify(minted.json.scopes) === JSON.stringify(["relay:device"]),
    JSON.stringify(minted.json.scopes),
  );

  const deviceInfo = () =>
    http(`${API}/v1/relay/info`, { headers: { Authorization: `Bearer ${deviceToken}` } });

  let device: Device | null = null;
  if (EXTERNAL_DEVICE) {
    heading("the REAL Mac app opens the socket and reaches auth.ok");
    const seededAt = (await deviceInfo()).json;
    const file = seedRealApp(deviceToken, seededAt.uid, seededAt.mcp_url);
    say(`   seeded ${file}`);
    say(`   launch the app with DOMO_HOME=${path.resolve(DOMO_HOME)} DOMO_API_BASE_URL=${API}`);
    say(`   (the app derives the socket from that origin; DOMO_HOME must match, or it dials with another home's credential)`);
    say(`   waiting for the app to dial in…`);
    const started = Date.now();
    let connected = false;
    while (Date.now() - started < 180_000) {
      if ((await deviceInfo()).json?.device_connected === true) {
        connected = true;
        break;
      }
      await sleep(2_000);
    }
    check("GET /v1/relay/info reports the device connected", connected, `${Math.round((Date.now() - started) / 1000)}s`);
    if (!connected) {
      say("\nrelay gate: the app never reached auth.ok — nothing to call. Is it running with the right DOMO_API_BASE_URL?");
      return;
    }
  } else {
    heading("the headless device opens the socket and reaches auth.ok");
    device = startDevice(deviceToken);
    await device.connect();
    const connectedInfo = await deviceInfo();
    check("GET /v1/relay/info reports the device connected", connectedInfo.json?.device_connected === true);
    check("no electron in this process", (process as any).versions.electron === undefined, `node ${process.versions.node}`);
  }
  const uidA: string = (await deviceInfo()).json.uid;

  heading("POST /v1/relay/agents → agent credential + mcp_config");
  const agent = await postJson(
    `${API}/v1/relay/agents`,
    { name: `gate agent ${runId}` },
    { Authorization: `Bearer ${deviceToken}` },
  );
  check("mint returns 200", agent.status === 200, mintDetail(agent));
  check(
    "scope is exactly relay:call",
    JSON.stringify(agent.json.scopes) === JSON.stringify(["relay:call"]),
    JSON.stringify(agent.json.scopes),
  );
  const target = targetFromConfig(agent.json.mcp_config);
  check("mcp_config carries the URL and the bearer header", Boolean(target.url) && Boolean(target.headers.Authorization), target.url);
  check("the credential is not in the URL", !target.url.includes(agent.json.token));
  await settle(target);

  heading("tools/list through the tunnel");
  const listed = await rpc(target, "tools/list");
  const toolNames: string[] = (listed.json?.result?.tools ?? []).map((t: any) => t.name);
  check("200 through the relay", listed.status === 200, `status ${listed.status}`);
  check(
    "the Mac tools are advertised (core + browser)",
    toolNames.includes("run_command") && toolNames.includes("browser_open"),
    toolNames.join(", "),
  );

  heading("tools/call run_command — the nonce and the machine come back");
  const nonce = `relay-gate-nonce-${crypto.randomUUID()}`;
  fs.mkdirSync(NONCE_DIR, { recursive: true });
  fs.writeFileSync(NONCE_FILE, `${nonce}\n`);
  const called = await callTool(target, "run_command", {
    argv: NONCE_ARGV,
    read_paths: [NONCE_FILE],
    goal: "prove this ran on the device at the far end of the socket",
  });
  const { payload, isError } = toolPayload(called);
  const output: string = payload?.output ?? "";
  check("200 through the relay", called.status === 200, `status ${called.status}`);
  check("the tool did not error", !isError, JSON.stringify(payload).slice(0, 200));
  check("the per-run nonce came back", output.includes(nonce), JSON.stringify(output));
  check("the device's hostname came back", output.trim().split("\n").length >= 2, JSON.stringify(output));
  say(`   nonce sent    : ${nonce}`);
  say(`   device output : ${JSON.stringify(output)}`);
  say(`   exit code     : ${payload?.exit_code}`);

  if (EXTERNAL_DEVICE || device === null) {
    say("\n   acceptance mode: one approval prompt is expected per run, and only one —");
    say("   the argv and its read path are constant, so the rule key is too. A fresh");
    say("   agent credential each run does change the key, so Always Allow persists");
    say("   within a run, not across runs.");
    return;
  }

  heading("deferred results: pending → ready");
  const slow = await callTool(target, "run_command", {
    argv: ["/bin/sh", "-c", `sleep 5; echo ${nonce}-deferred`],
    goal: "outrun the call budget on purpose",
  });
  const deferred = toolPayload(slow).payload;
  check("a slow call defers rather than blocking", deferred?.status === "pending", JSON.stringify(deferred));
  const handle: string = deferred?.handle;
  let ready: any = null;
  for (let i = 0; i < 20; i += 1) {
    await sleep(1_000);
    ready = toolPayload(await callTool(target, "get_result", { handle })).payload;
    if (ready?.status !== "pending") break;
  }
  check("the handle resolves to ready", ready?.status === "ready", JSON.stringify(ready).slice(0, 200));
  // Two hops, as run_command's own description says: the ready payload IS the
  // run_command result, and for a command that outran the in-call wait that
  // result is a job handle. The output comes back through get_output.
  const jobHandle: string = ready?.result?.handle;
  check("the ready payload is the run_command result, job handle and all", Boolean(jobHandle), JSON.stringify(ready?.result));
  let jobOutput = String(ready?.result?.output ?? "");
  for (let i = 0; i < 15 && !jobOutput.includes(`${nonce}-deferred`); i += 1) {
    await sleep(1_000);
    jobOutput = String(toolPayload(await callTool(target, "get_output", { handle: jobHandle })).payload?.output ?? "");
  }
  check(
    "the deferred command's own output carries the nonce",
    jobOutput.includes(`${nonce}-deferred`),
    JSON.stringify(jobOutput),
  );

  heading("a handle belonging to another agent is refused");
  const secondAgent = await postJson(
    `${API}/v1/relay/agents`,
    { name: `gate agent 2 ${runId}` },
    { Authorization: `Bearer ${deviceToken}` },
  );
  const otherTarget = targetFromConfig(secondAgent.json.mcp_config);
  await settle(otherTarget);
  const foreign = toolPayload(await callTool(otherTarget, "get_result", { handle })).payload;
  check(
    "another agent's handle answers unknown",
    foreign?.status === "unknown",
    JSON.stringify(foreign),
  );

  heading("no credential → 401, wrong scope → 403, another account → 403");
  const anonymous = await http(target.url, {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-method": "tools/list" },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  });
  check("no credential", anonymous.status === 401, `status ${anonymous.status}`);

  const wrongScope = await rpc({ url: target.url, headers: { Authorization: `Bearer ${deviceToken}` } }, "tools/list");
  check("relay:device against the agent endpoint", wrongScope.status === 403, `status ${wrongScope.status}`);

  const portalB = await portalSession(phoneB, "relay gate B");
  const agentB = await postJson(
    `${API}/v1/relay/agents`,
    { name: `gate agent B ${runId}` },
    { Authorization: `Bearer ${portalB}` },
  );
  const targetB = targetFromConfig(agentB.json.mcp_config);
  await settle(targetB);
  const crossAccount = await rpc({ url: target.url, headers: targetB.headers }, "tools/list");
  check(
    "account B's agent against account A's device uid",
    crossAccount.status === 403,
    `status ${crossAccount.status}`,
  );
  check("account B addresses a different device uid", !targetB.url.includes(uidA), targetB.url);

  heading("the four revisions this server refuses, and a header that disagrees");
  for (const revision of BAD_REVISIONS) {
    const rejected = await rpc(target, "tools/list", {}, { protocolVersion: revision });
    check(
      `revision ${revision} → 400, not 5xx`,
      rejected.status === 400 && rejected.status < 500,
      `status ${rejected.status} code ${rejected.json?.error?.code}`,
    );
  }
  const disagreeing = await rpc(target, "tools/list", {}, { headers: { "mcp-method": "tools/call" } });
  check(
    "header/body disagreement → 400, not 5xx",
    disagreeing.status === 400 && disagreeing.status < 500,
    `status ${disagreeing.status} code ${disagreeing.json?.error?.code}`,
  );

  heading("a body over 8 MiB is refused, not buffered");
  const oversized = await http(target.url, {
    method: "POST",
    headers: { ...target.headers, "content-type": "application/json", "mcp-method": "tools/list" },
    body: "x".repeat(MAX_BODY_BYTES + 1),
  });
  check("8 MiB + 1 byte", oversized.status === 413, `status ${oversized.status}`);

  heading("the reroute case: a device reconnects mid-request");
  const rerouteNonce = `relay-gate-reroute-${crypto.randomUUID()}`;
  const before = device.decided.filter((r) => r.includes(rerouteNonce)).length;
  const inFlight = callTool(target, "run_command", {
    argv: ["/bin/sh", "-c", `echo ${rerouteNonce}; sleep 2`],
    wait_ms: 2_500,
    goal: "still running when the socket is replaced",
  });
  await sleep(400);
  await device.reconnect(); // a second socket on the same credential evicts the first
  const rerouted = await inFlight;
  const executions = device.decided.filter((r) => r.includes(rerouteNonce)).length - before;
  const deliveries = device.served.filter((b) => b.includes(rerouteNonce)).length;
  check("executed exactly once on the device", executions === 1, `executions=${executions}`);
  check("delivered exactly once to the device", deliveries === 1, `deliveries=${deliveries}`);
  // 502 is precisely the pre-fix symptom, and the whole point of the case: a
  // call the Mac has already RUN must never come back "disconnected", because
  // that reads as "it never happened" and invites a retry — the duplicate
  // execution this case exists to prevent. Post-fix a delivered call waits out
  // the relay's budget and gets 504 instead. Assert on that, not merely on the
  // execution count: the count alone stays 1 on the broken build too, because
  // this harness is not the client that would retry.
  check(
    "a delivered call is never answered 'disconnected'",
    rerouted.status !== 502,
    `status ${rerouted.status}`,
  );
  check(
    "it waits out the relay budget instead",
    rerouted.status === 504,
    `status ${rerouted.status}`,
  );
  say(`   reroute call returned status ${rerouted.status}`);

  heading("the device drops mid-request: a call it already ran is not 'disconnected'");
  const dropNonce = `relay-gate-drop-${crypto.randomUUID()}`;
  const dropping = callTool(target, "run_command", {
    argv: ["/bin/sh", "-c", `echo ${dropNonce}; sleep 2`],
    wait_ms: 2_500,
    goal: "in flight when the socket goes away",
  });
  await sleep(400);
  await device.disconnect(); // the CURRENT socket goes, with nothing replacing it
  const dropped = await dropping;
  const dropExecutions = device.decided.filter((r) => r.includes(dropNonce)).length;
  check("executed exactly once on the device", dropExecutions === 1, `executions=${dropExecutions}`);
  // This is the leg the fix moved. Pre-fix, detach failed every pending call
  // on the current socket's teardown — including one send_to had already
  // handed over — so the agent got 502 "disconnected" for work the Mac had
  // run, and a retry would have run it twice. 502 here is the bug.
  check(
    "not answered 'disconnected' for work the Mac already did",
    dropped.status !== 502,
    `status ${dropped.status}`,
  );
  check("waits out the relay budget instead", dropped.status === 504, `status ${dropped.status}`);

  heading("device offline → a fast, non-paging failure");
  await sleep(500);
  const offlineAt = Date.now();
  const offline = await rpc(target, "tools/list");
  const offlineMs = Date.now() - offlineAt;
  // NON_PAGING_STATUSES in plow/alerts/middleware.py exempts exactly these
  // three on this route — a sleeping Mac must never wake a human.
  check(
    "offline status is one ErrorAlertMiddleware does not page on",
    [502, 503, 504].includes(offline.status),
    `status ${offline.status} in ${offlineMs}ms`,
  );
  check("and it fails fast", offlineMs < 5_000, `${offlineMs}ms`);

  fs.rmSync(device.home, { recursive: true, force: true });
}

main()
  .then(() => {
    say(`\n${failures === 0 ? "GATE PASSED" : `GATE FAILED — ${failures} check(s) red`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((error: unknown) => {
    say(`\nrelay gate: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    say("GATE FAILED");
    process.exit(1);
  });
