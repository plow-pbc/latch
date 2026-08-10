// The chunk-10 round trip, end to end, with timings.
//
// An agent asks for something a human must approve. The call cannot wait, so it
// comes back with a handle inside the budget. The human answers minutes later.
// The agent collects the result. Then the same for a command that outruns the
// budget. Nothing anywhere blocks past the relay's ceiling.
//
//   just slow-approval-transcript
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { ApprovalStore, DeviceAgent } from "../../../packages/device-core/dist/index.js";
import { createDomoMcpServer, CALL_BUDGET_MS, PROTOCOL_REVISION } from "../../../packages/mcp-server/dist/index.js";
import { RelayClient } from "../../../packages/relay-client/dist/index.js";
import { FakeRelay } from "../../../packages/relay-client/test/fakeRelay.ts";

const RELAY_TIMEOUT_MS = 20_000;   // the relay gives up here
const APPROVE_AFTER_MS = 12_000;   // the human, well past the budget
const T0 = Date.now();
const at = () => `t+${String(Date.now() - T0).padStart(6)}ms`;
const say = (who, what) => console.log(`${at()}  ${who.padEnd(9)} ${what}`);
const budgets = [];

const CRED = "plow_sk_relay_connect_TRANSCRIPT";
const relay = await FakeRelay.start({ expectCredential: CRED, pingIntervalMs: 15_000 });
const home = fs.mkdtempSync(path.join(os.tmpdir(), "chunk10-"));

// The "human": never answers on its own. The transcript answers it, late.
const approvals = new ApprovalStore(
  path.join(home, "device/approvals"),
  { decideIntent: () => new Promise(() => {}) },
);
const device = new DeviceAgent(home, "Demo Mac", approvals);
const mcp = createDomoMcpServer(device);
const client = new RelayClient({ url: relay.url, credential: CRED, serve: (r, a) => mcp.fetch(r, a) });
await client.start();
await relay.waitForDevice();
say("mac", `connected. call budget ${CALL_BUDGET_MS}ms, relay gives up at ${RELAY_TIMEOUT_MS}ms`);

const AGENT = { agent_id: "sess_alice", agent_name: "Claude Code", user_uid: "u-1" };
const call = async (label, name, args) => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args, _meta: {
      "io.modelcontextprotocol/protocolVersion": PROTOCOL_REVISION,
      "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {} } } });
  const started = Date.now();
  const res = await relay.agentCall({ method: "POST", path: "/v1/relay/devices/u-1/mcp",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_REVISION, "mcp-method": "tools/call", "mcp-name": name },
    body }, AGENT, RELAY_TIMEOUT_MS);
  const took = Date.now() - started;
  budgets.push([label, took]);
  say("agent", `${label} -> ${took}ms`);
  return JSON.parse(JSON.parse(res.body).result.content[0].text);
};

// ---- 1. a call that needs a human -------------------------------------------
const secret = path.join(home, "quarterly.txt");
fs.writeFileSync(secret, "the numbers");
say("agent", "calls read_file (needs approval)");
const first = await call("read_file", "read_file", { path: secret, goal: "summarise the quarter" });
say("agent", `got ${JSON.stringify(first)}`);

const [record] = approvals.all();
say("disk", `${record.status} approval on disk: ${record.agentName} — ${record.request}`);
say("disk", `  expires ${record.expiresAt} (capabilities: ${record.capabilities.join(", ")})`);

// The agent keeps polling while the human is away.
let poll = first;
const pollStart = Date.now();
setTimeout(() => {
  say("human", "walks back and clicks Allow Once");
  approvals.resolve(record.intentId, "allow_once", "human");
}, APPROVE_AFTER_MS);

let polls = 0;
while (poll.status === "pending") {
  await new Promise((r) => setTimeout(r, 1_000));
  polls += 1;
  poll = await call(`get_result #${polls}`, "get_result", { handle: first.handle });
}
say("agent", `result after ${polls} polls, ${Date.now() - pollStart}ms of waiting: ${JSON.stringify(poll).slice(0, 120)}`);
say("disk", `approval now: ${approvals.all()[0].status} / ${approvals.all()[0].decision} (by ${approvals.all()[0].source})`);

// ---- 2. a command that outruns the budget -----------------------------------
say("agent", "calls run_command (sleeps 12s — outruns the budget)");
const auto = new Promise((r) => setTimeout(r, 300));
const cmdCall = call("run_command", "run_command", { argv: ["/bin/sh", "-c", "echo starting; sleep 12; echo finished"], wait_ms: 60_000 });
await auto;
const cmdRecord = approvals.all().find((r) => r.status === "pending");
if (cmdRecord) { say("human", "approves the command immediately"); approvals.resolve(cmdRecord.intentId, "allow_once", "human"); }
const cmd = await cmdCall;
say("agent", `deferred handle, reason=${cmd.reason}`);

let ready = cmd;
while (ready.status === "pending") {
  await new Promise((r) => setTimeout(r, 1_000));
  ready = await call("get_result", "get_result", { handle: cmd.handle });
}
say("agent", `job handle ${ready.result.handle} (status ${ready.result.status})`);
let out = ready.result;
while (out.status === "running") {
  await new Promise((r) => setTimeout(r, 1_000));
  out = await call("get_output", "get_output", { handle: ready.result.handle });
}
say("agent", `command finished exit=${out.exit_code}: ${JSON.stringify(out.output)}`);

// ---- 3. the invariant --------------------------------------------------------
const worst = Math.max(...budgets.map(([, ms]) => ms));
console.log("");
console.log(`slowest tunnelled call: ${worst}ms`);
console.log(`call budget:            ${CALL_BUDGET_MS}ms`);
console.log(`relay gives up at:      ${RELAY_TIMEOUT_MS}ms`);
console.log(worst < RELAY_TIMEOUT_MS ? "PASS: no call blocked past the relay timeout" : "FAIL");

await client.stop(); await mcp.close(); await relay.stop();
fs.rmSync(home, { recursive: true, force: true });
process.exit(worst < RELAY_TIMEOUT_MS ? 0 : 1);
