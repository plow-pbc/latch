// Manual HTTP smoke run. Uses synthetic history, a temporary owner profile,
// the shipping plugin, real MCP handler, system curl and macOS seatbelt.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeviceAgent, loadPlugins } from "../packages/device-core/dist/index.js";
import { createDomoMcpServer, PROTOCOL_REVISION } from "../packages/mcp-server/dist/index.js";
import { approvalViewModel } from "../apps/desktop/dist/viewModel.js";

assert.equal(process.platform, "darwin", "This smoke run requires macOS seatbelt.");
const outputDir = path.resolve(process.argv[2] ?? "work/screenpipe-smoke");
fs.mkdirSync(outputDir, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "latch-screenpipe-smoke-"));
const token = `sp-${crypto.randomUUID()}`;
const requests = [];
const approvals = [];
const cases = [];
let mode = "ok";
let decision = "allow_once";
const history = {
  data: [{ type: "UI", content: { frame_id: 42, text: "Synthetic design & review notes for the Screenpipe plugin", app_name: "Safari", window_name: "Design review", timestamp: "2026-10-01T12:00:00Z" } }],
  pagination: { limit: 10, offset: 0, total: 1 },
};
const backend = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authenticated: req.headers.authorization === `Bearer ${token}` });
  assert.equal(req.method, "GET");
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/health") {
    res.end(JSON.stringify({ status: "healthy", frame_status: "ok", audio_status: "ok", last_frame_timestamp: "2026-10-01T12:00:00Z", last_audio_timestamp: "2026-10-01T12:00:00Z" }));
  } else if (mode === "auth-error" || req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(403).end(JSON.stringify({ error: `Do not expose this fixture key: ${token}` }));
  } else if (mode === "redirect") {
    res.writeHead(302, { Location: "/must-not-follow" }).end("redirect body must not reach the agent");
  } else {
    assert.equal(url.pathname, "/search");
    assert.ok(["ascending", "descending"].includes(url.searchParams.get("order")), "Order must use Screenpipe's API vocabulary.");
    res.end(JSON.stringify(history));
  }
});
await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
const address = backend.address();
assert.ok(address && typeof address === "object");
const pluginRoot = path.join(temporary, "plugins");
const pluginDir = path.join(pluginRoot, "screenpipe");
fs.cpSync(fileURLToPath(new URL("../apps/desktop/plugins/screenpipe", import.meta.url)), pluginDir, { recursive: true });
const manifestPath = path.join(pluginDir, "latch-plugin.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.env.SCREENPIPE_API_PORT.fixed = String(address.port);
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
const owner = path.join(temporary, "owner");
const configDir = path.join(owner, ".config", "plow-latch");
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, "screenpipe-api-key"), token, { mode: 0o600 });
const device = new DeviceAgent(path.join(temporary, "device"), "Synthetic Mac", {
  async decideIntent(intent) { approvals.push(intent); return decision; },
}, null, owner, null, loadPlugins([pluginRoot]));
const server = createDomoMcpServer(device);
let id = 0;
async function call(name, args) {
  const response = await server.fetch(new Request("http://mac/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "mcp-protocol-version": PROTOCOL_REVISION, "mcp-method": "tools/call", "mcp-name": name },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_REVISION, "io.modelcontextprotocol/clientInfo": { name: "screenpipe-smoke", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }),
  }), { agent_id: "synthetic-history-assistant", agent_name: "Synthetic history assistant", scopes: ["relay:call"] });
  const rpc = await response.json();
  assert.ok(rpc.result, JSON.stringify(rpc));
  const payload = JSON.parse(rpc.result.content[0].text);
  assert.ok(!JSON.stringify(payload).includes(token), "Credential leaked to the agent.");
  return { isError: rpc.result.isError === true, payload };
}
async function command(label, argv, extra = {}) {
  const before = requests.length;
  const result = await call("plow_run_command", { argv: ["plow-screenpipe", ...argv], wait_ms: 5000, ...extra });
  cases.push({ label, request: { argv: ["plow-screenpipe", ...argv], ...extra }, ...result, httpRequests: requests.length - before });
  const verdict = result.isError || result.payload.exit_code > 0 || result.payload.status === "denied" ? "refused" : "completed";
  console.log(`${label}: ${verdict}; HTTP requests=${requests.length - before}`);
  return result;
}
try {
  const help = await command("help", ["--help"]);
  assert.equal(help.payload.exit_code, 0);
  assert.ok(help.payload.output.includes("plow-screenpipe search"));
  assert.equal(cases.at(-1).httpRequests, 0);
  const health = await command("health", ["health"], { network: true });
  assert.equal(health.payload.exit_code, 0);
  assert.equal(JSON.parse(health.payload.output).status, "healthy");
  assert.equal(cases.at(-1).httpRequests, 1);
  assert.equal(requests.at(-1).authenticated, false);
  const search = await command("search", ["search", "--query", "design & review", "--app-name", "Safari", "--content-type", "accessibility", "--limit", "10"], { network: true, read_paths: [configDir], goal: "Find yesterday's synthetic design review notes." });
  assert.equal(search.isError, false);
  assert.equal(search.payload.exit_code, 0);
  assert.equal(cases.at(-1).httpRequests, 1);
  assert.deepEqual(JSON.parse(search.payload.output), history);
  assert.deepEqual(requests.at(-1).query, { content_type: "accessibility", limit: "10", offset: "0", order: "descending", include_frames: "false", include_cloud: "false", max_content_length: "2000", q: "design & review", app_name: "Safari" });
  assert.equal(requests.at(-1).authenticated, true);
  fs.writeFileSync(path.join(outputDir, "approval-view.json"), JSON.stringify({ kind: "intent", view: approvalViewModel(approvals.at(-1)) }, null, 2));

  decision = "deny";
  assert.equal((await command("owner denial", ["search"], { network: true })).payload.status, "denied");
  assert.equal(cases.at(-1).httpRequests, 0);
  decision = "allow_once";
  assert.equal((await command("network denied", ["health"])).payload.exit_code, 1);
  assert.equal(cases.at(-1).httpRequests, 0);
  mode = "auth-error";
  assert.equal((await command("authentication failure", ["search"], { network: true, read_paths: [configDir] })).payload.exit_code, 1);
  mode = "redirect";
  assert.equal((await command("redirect refused", ["search"], { network: true, read_paths: [configDir] })).payload.exit_code, 1);
  assert.equal(cases.at(-1).httpRequests, 1);
  await device.setDisabledPlugins(["screenpipe"]);
  assert.equal((await command("plugin off", ["search"], { network: true })).isError, true);
  assert.equal(cases.at(-1).httpRequests, 0);
  await device.setDisabledPlugins([]);
  assert.equal((await command("recording control refused", ["record"], { network: true })).isError, true);
  assert.equal(cases.at(-1).httpRequests, 0);

  const audit = device.audit.entries();
  assert.ok(!JSON.stringify(audit).includes(token), "Credential leaked to audit.");
  fs.writeFileSync(path.join(outputDir, "smoke-report.json"), JSON.stringify({ backend: "synthetic Screenpipe HTTP API fixture; no real capture", execution: "shipping plugin through real Latch MCP, system curl and macOS seatbelt; headless owner-policy decisions", cases, requests }, null, 2));
  fs.writeFileSync(path.join(outputDir, "smoke-audit.ndjson"), audit.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  console.log(`PASS: ${cases.length} cases. Evidence saved to ${outputDir}`);
} finally {
  await server.close();
  await new Promise((resolve) => backend.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}
