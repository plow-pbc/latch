/**
 * The relay REALISM smoke test — a real model as the MCP client.
 *
 *   just relay-domo
 *
 * This is a SMOKE TEST, NEVER A GATE. `just relay-gate` is the gate: it is
 * deterministic, it localises faults, and it must stay green. This one asks a
 * question the gate cannot: given the `mcp_config` blob we hand out, does a
 * real model — choosing for itself — call a tool through the relay and get back
 * a value that could only have come from the far end of the socket? A model
 * declining to call a tool is not a relay defect, so a red run here reports
 * separately and never blocks the pipeline.
 *
 * LOCAL ONLY. The earlier prototype ran the model inside a Cloudflare Worker
 * (docs/DOMO-QUICKSTART.md in the e2b repo). There is no wrangler config and no
 * CLOUDFLARE_API_TOKEN on this machine, and local-only removes the public
 * exposure the APP_PASSWORD requirement existed for — so the model runs in this
 * process against the local relay stack, and the security boundary is the
 * loopback interface plus the per-run agent credential.
 *
 * The device end is the same headless `DeviceAgent` + `createDomoMcpServer` +
 * `RelayClient` trio the gate uses, in this process, with a temp home. Nothing
 * touches the head chef's real Mac.
 *
 * The tool surface handed to the model is ONE tool: `read_file`. The relay still
 * advertises all seven — the filter is at the model layer, deliberately, because
 * a model-driven loop must not be able to reach `run_command` or `write_file`
 * while the approval and sandbox layers belong to another team.
 */
import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { DeviceAgent, PolicyDelegate } from "@domo/device-core";
import { Intent } from "@domo/protocol";
import { createDomoMcpServer, DomoMcpServer, PROTOCOL_REVISION } from "@domo/mcp-server";
import { RelayClient } from "@domo/relay-client";

// ---------------------------------------------------------------------------
// Configuration. Same stack the gate defaults to (the relay-prb variant).
// ---------------------------------------------------------------------------

const API = process.env.RELAY_DOMO_API ?? "http://127.0.0.1:19264";
const TWIN = process.env.RELAY_DOMO_TWIN ?? "http://127.0.0.1:19265";
const WS_URL = (process.env.RELAY_DOMO_WS ?? API.replace(/^http/, "ws")) + "/v1/relay/ws";

const MODEL = process.env.RELAY_DOMO_MODEL ?? "claude-opus-5";

/**
 * Where the model's credential comes from. The head chef believed the keys were
 * already on this machine; they are, in the plow worktree's `.env` as
 * `PLOW_BUNDLED_ANTHROPIC_API_KEY`. An exported ANTHROPIC_API_KEY wins if set.
 * The value is read, used, and never printed.
 */
const ENV_FILE =
  process.env.RELAY_DOMO_ENV_FILE ?? path.join(os.homedir(), "plow-pbc/plow/relay/.env");
const ENV_FILE_KEY = process.env.RELAY_DOMO_ENV_FILE_KEY ?? "PLOW_BUNDLED_ANTHROPIC_API_KEY";

const BUDGET_MS = 3_000;

/** The nonce file the model has to read to answer. Fixed dir, per-run name. */
const NONCE_DIR = "/private/tmp/relay-domo";

/** Stop a runaway loop: the task needs one tool call, two is already generous. */
const MAX_TURNS = 6;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

let failures = 0;
let step = 0;

const say = (m: string): void => void process.stdout.write(`${m}\n`);

function heading(title: string): void {
  step += 1;
  say(`\n── ${step}. ${title}`);
}

function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  say(`   ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function missing(what: string, how: string): never {
  say(`\nrelay domo: ${what}`);
  say(`relay domo: ${how}`);
  process.exit(2);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * What a mint response is allowed to say in the transcript.
 *
 * The mint bodies carry the credential itself. This report is meant to be read
 * and pasted, and every credential leak on this project came from a value
 * reaching a terminal — so a failing mint shows its status and its error, and a
 * succeeding one shows only the fields worth checking.
 */
function mintDetail(result: HttpResult): string {
  if (result.status !== 200) return `status ${result.status}: ${result.text.slice(0, 200)}`;
  const { key_prefix, scopes, name } = result.json ?? {};
  return `key_prefix ${key_prefix} · scopes ${JSON.stringify(scopes)} · name ${JSON.stringify(name)}`;
}

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
    /* status is what the negatives assert */
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

/** The model credential, read from the environment or the plow worktree's .env. */
function anthropicKey(): string {
  const exported = process.env.ANTHROPIC_API_KEY;
  if (exported) {
    say(`   model credential: ANTHROPIC_API_KEY from the environment`);
    return exported;
  }
  if (!fs.existsSync(ENV_FILE)) {
    missing(
      `no model credential: ANTHROPIC_API_KEY is unset and ${ENV_FILE} does not exist`,
      "export ANTHROPIC_API_KEY, or point RELAY_DOMO_ENV_FILE at a .env holding one",
    );
  }
  // Deliberately a line-oriented read of one named key, not a dotenv loader:
  // this file holds several unrelated secrets and none of the others belong in
  // this process's environment.
  const line = fs
    .readFileSync(ENV_FILE, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${ENV_FILE_KEY}=`));
  if (!line) {
    missing(
      `no model credential: ${ENV_FILE} has no ${ENV_FILE_KEY}`,
      "export ANTHROPIC_API_KEY instead, or set RELAY_DOMO_ENV_FILE_KEY",
    );
  }
  const value = line.slice(ENV_FILE_KEY.length + 1).trim().replace(/^["']|["']$/g, "");
  if (!value) missing(`${ENV_FILE_KEY} in ${ENV_FILE} is empty`, "set it, or export ANTHROPIC_API_KEY");
  say(`   model credential: ${ENV_FILE_KEY} from ${ENV_FILE}`);
  return value;
}

async function preflight(): Promise<string> {
  heading("preflight");
  try {
    const health = await http(`${API}/health`, { timeoutMs: 4_000 });
    if (health.status !== 200) throw new Error(`status ${health.status}`);
  } catch (error: unknown) {
    missing(
      `the Plow API is not answering at ${API} (${String(error)})`,
      "start it: cd <plow worktree>/api && just up   (or set RELAY_DOMO_API)",
    );
  }
  try {
    const health = await http(`${TWIN}/health`, { timeoutMs: 4_000 });
    if (health.status !== 200) throw new Error(`status ${health.status}`);
  } catch (error: unknown) {
    missing(
      `the linq twin is not answering at ${TWIN} (${String(error)})`,
      "it comes up with the same stack: just up starts dtu-linq   (or set RELAY_DOMO_TWIN)",
    );
  }
  check("API and linq twin are up", true, `${API} · ${TWIN}`);
  const key = anthropicKey();
  check("a model credential was already on this machine", true, `model ${MODEL}`);
  return key;
}

// ---------------------------------------------------------------------------
// Step 1 — a real account, and a portal session minted by a real OTP.
// ---------------------------------------------------------------------------

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
    const redeemed = await postJson(`${API}/v1/auth/activate/redeem`, { activation_secret });
    if (redeemed.json?.status === "verified") return;
    await sleep(500);
  }
  throw new Error(`activation never verified for ${phone}`);
}

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
// The device end — headless, and recording every decision it made.
// ---------------------------------------------------------------------------

interface Device {
  /** Every intent this Mac was asked to decide — one entry per execution. */
  readonly decided: string[];
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  home: string;
}

function startDevice(credential: string): Device {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-domo-device-"));
  const decided: string[] = [];

  // The sanctioned headless approval path: a PolicyDelegate that answers. It IS
  // the approver — nothing here bypasses the approval layer — and every
  // decision lands in `decided` and in the device's own audit log.
  const policy: PolicyDelegate = {
    async decideIntent(intent: Intent) {
      decided.push(intent.request);
      return "allow_once";
    },
  };

  const device = new DeviceAgent(home, "relay domo mac", policy);
  const server: DomoMcpServer = createDomoMcpServer(device, { budgetMs: BUDGET_MS });

  const client = new RelayClient({
    url: WS_URL,
    credential,
    serve: async (request, auth) => server.fetch(request, auth),
    log: () => {},
  });

  return {
    decided,
    home,
    async connect() {
      await client.start();
      const started = Date.now();
      while (!client.isConnected) {
        if (Date.now() - started > 15_000) throw new Error(`device never reached auth.ok on ${WS_URL}`);
        await sleep(50);
      }
    },
    async disconnect() {
      await client.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// The MCP leg — over the config the API handed out, never hand-assembled.
// ---------------------------------------------------------------------------

interface McpTarget {
  url: string;
  headers: Record<string, string>;
}

/** Read the URL and headers out of `mcp_config` verbatim. That blob IS the product. */
function targetFromConfig(mcpConfig: string): McpTarget {
  const parsed = JSON.parse(mcpConfig);
  const entry = parsed?.mcpServers?.plow;
  assert.ok(entry, `mcp_config has no mcpServers.plow: ${mcpConfig}`);
  assert.equal(entry.type, "http", `mcp_config type is ${entry.type}`);
  return { url: entry.url as string, headers: entry.headers as Record<string, string> };
}

let nextId = 1;

async function rpc(
  target: McpTarget,
  method: string,
  params: Record<string, unknown> = {},
): Promise<HttpResult> {
  return http(target.url, {
    method: "POST",
    headers: {
      ...target.headers, // the credential, exactly as mcp_config carries it
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_REVISION,
      "mcp-method": method,
      ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_REVISION,
          "io.modelcontextprotocol/clientInfo": { name: "relay-domo", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

/**
 * A freshly minted credential can 401 for a few ms — `get_db` commits in
 * FastAPI's dependency teardown, after the response has gone out. The gate
 * carries the same wait and the same finding.
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

async function main(): Promise<void> {
  const runId = crypto.randomUUID().slice(0, 8);
  const phone = `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;

  say(`relay domo smoke ${runId} — API ${API}, device socket ${WS_URL}`);
  say("this is a SMOKE TEST, not a gate: `just relay-gate` is the gate");
  const apiKey = await preflight();

  heading("OTP through the twin → portal session");
  const portal = await portalSession(phone, "relay domo");
  check("the account holds a portal session", portal.startsWith("plow_"), `phone ${phone}`);

  heading("POST /v1/relay/devices → a device credential, and nothing wider");
  const minted = await postJson(
    `${API}/v1/relay/devices`,
    { name: `relay domo ${runId}`, revoke_calling_session: false },
    { Authorization: `Bearer ${portal}` },
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

  heading("the headless device opens the socket and reaches auth.ok");
  const device = startDevice(deviceToken);
  await device.connect();
  check("GET /v1/relay/info reports the device connected", (await deviceInfo()).json?.device_connected === true);
  check("no electron in this process", (process as any).versions.electron === undefined, `node ${process.versions.node}`);

  heading("POST /v1/relay/agents → a per-run agent credential + mcp_config");
  const agent = await postJson(
    `${API}/v1/relay/agents`,
    { name: `domo agent ${runId}` },
    { Authorization: `Bearer ${deviceToken}` },
  );
  check("mint returns 200", agent.status === 200, mintDetail(agent));
  check(
    "scope is exactly relay:call",
    JSON.stringify(agent.json.scopes) === JSON.stringify(["relay:call"]),
    JSON.stringify(agent.json.scopes),
  );
  const agentPrefix: string = agent.json.key_prefix;
  const target = targetFromConfig(agent.json.mcp_config);
  check("mcp_config carries the URL and the bearer header", Boolean(target.url) && Boolean(target.headers.Authorization), target.url);
  check("the credential is not in the URL", !target.url.includes(agent.json.token));
  await settle(target);

  heading("tools/list through the tunnel — the model's tool surface");
  const listed = await rpc(target, "tools/list");
  const advertised: any[] = listed.json?.result?.tools ?? [];
  check("200 through the relay", listed.status === 200, `status ${listed.status}`);
  const readFile = advertised.find((t) => t.name === "read_file");
  check("read_file is advertised", Boolean(readFile), advertised.map((t) => t.name).join(", "));
  assert.ok(readFile, "no read_file tool to hand the model");
  // Deliberate: the relay advertises all seven; the model gets exactly one, and
  // it is read-only. run_command and write_file never reach the model layer.
  say(`   relay advertises  : ${advertised.map((t) => t.name).join(", ")}`);
  say(`   model is offered  : read_file (read-only, deterministic, echo-shaped)`);

  heading("a real model, given only mcp_config's tool, chooses to call it");
  const nonce = `relay-domo-nonce-${crypto.randomUUID()}`;
  fs.mkdirSync(NONCE_DIR, { recursive: true });
  const noncePath = path.join(NONCE_DIR, `${runId}.txt`);
  fs.writeFileSync(noncePath, `${nonce}\n`);
  say(`   nonce written to  : ${noncePath}`);
  say(`   nonce sent        : ${nonce}`);

  const anthropic = new Anthropic({ apiKey });

  // The tool definition is the MCP schema from tools/list, verbatim — the same
  // rule as consuming mcp_config: if what the relay advertises is wrong, this
  // run must break rather than paper over it with a hand-written schema.
  const tools = [
    {
      name: readFile.name as string,
      description: readFile.description as string,
      input_schema: readFile.inputSchema as any,
    },
  ];

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `There is a Mac connected to you over MCP. A file on it, at ${noncePath}, ` +
        `contains a single verification token. Read that file and reply with the ` +
        `token exactly as it appears, and nothing else. Do not guess: if you cannot ` +
        `read the file, say so.`,
    },
  ];

  let toolCalls = 0;
  let nonceCameBack = false;
  let finalText = "";

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system:
        "You are connected to a Mac through the Plow relay. When you need something " +
        "from that machine, use the tools. Never fabricate a value you were asked to read.",
      tools,
      messages,
    });

    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        finalText = block.text;
        say(`   [model] ${block.text.trim().replace(/\n/g, "\n           ")}`);
      }
    }

    if (response.stop_reason !== "tool_use") break;

    messages.push({ role: "assistant", content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      toolCalls += 1;
      say(`   [tool call] ${block.name} ${JSON.stringify(block.input)}`);
      // Every tool call the model makes goes through the relay, over the
      // socket, to the device — no local shortcut.
      const called = await rpc(target, "tools/call", { name: block.name, arguments: block.input });
      const payload = called.json?.result?.content?.[0]?.text ?? JSON.stringify(called.json);
      const isError = called.json?.result?.isError === true || called.status !== 200;
      if (String(payload).includes(nonce)) nonceCameBack = true;
      say(`   [tool result] status ${called.status} ${String(payload).slice(0, 300)}`);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: String(payload),
        ...(isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });
  }

  check("the model chose to call a tool", toolCalls > 0, `${toolCalls} call(s)`);
  check("the call reached the device", device.decided.length > 0, device.decided.join(" · "));
  check("the per-run nonce came back through the relay", nonceCameBack, nonce);
  check("the model reported the nonce in its answer", finalText.includes(nonce), JSON.stringify(finalText.slice(0, 200)));
  check("the model called read_file only", device.decided.every((d) => d.startsWith("read file:")), device.decided.join(" · "));

  heading("prove the negatives: no credential → 401, wrong scope → 403");
  const anonymous = await http(target.url, {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-method": "tools/list" },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  });
  check("no credential", anonymous.status === 401, `status ${anonymous.status}`);

  const wrongScope = await rpc({ url: target.url, headers: { Authorization: `Bearer ${deviceToken}` } }, "tools/list");
  check("relay:device against the agent endpoint", wrongScope.status === 403, `status ${wrongScope.status}`);

  heading("the per-run agent credential is revoked, and proven dead");
  const keys = await http(`${API}/v1/api-keys`, { headers: { Authorization: `Bearer ${portal}` } });
  const row = (keys.json ?? []).find((k: any) => k.key_prefix === agentPrefix);
  check("the agent credential is listed", Boolean(row), `prefix ${agentPrefix}`);
  const revoked = await http(`${API}/v1/api-keys/${row?.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${portal}` },
  });
  check("DELETE /v1/api-keys/{id} → 200 revoked", revoked.status === 200 && revoked.json?.status === "revoked", revoked.text.slice(0, 200));
  const afterRevoke = await rpc(target, "tools/list");
  check("the revoked credential no longer works", afterRevoke.status === 401, `status ${afterRevoke.status}`);

  await device.disconnect();
  fs.rmSync(device.home, { recursive: true, force: true });
  fs.rmSync(noncePath, { force: true });
}

main()
  .then(() => {
    say(
      `\n${failures === 0 ? "SMOKE PASSED" : `SMOKE FAILED — ${failures} check(s) red`} (smoke test — the gate is \`just relay-gate\`)`,
    );
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((error: unknown) => {
    say(`\nrelay domo: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    say("SMOKE FAILED (smoke test — the gate is `just relay-gate`)");
    process.exit(1);
  });
