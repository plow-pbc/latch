/**
 * The MCP server on the Mac, end to end and entirely in process — no relay, no
 * socket, no port. A `Request` goes in, a `Response` comes out, and in between
 * a real capability set is built, run through the real policy engine, and
 * audited. The audit log is the oracle.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSONValue, jv } from "@domo/protocol";
import { DeviceAgent, HeadlessPolicy, PolicyDelegate } from "@domo/device-core";
import {
  CALL_BUDGET_MS,
  createDomoMcpServer,
  DomoMcpServer,
  HANDLE_TTL_MS,
  PROTOCOL_REVISION,
  RelayAuth,
  toAuthInfo,
} from "@domo/mcp-server";
import { callTool, parse, rpc } from "./client.js";

const cleanups: (() => void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-mcp-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const AGENT: RelayAuth = { agent_id: "agent-1", agent_name: "Agent One", scopes: ["relay:call"] };
const OTHER: RelayAuth = { agent_id: "agent-2", agent_name: "Agent Two", scopes: ["relay:call"] };

/** A policy delegate whose answer the test controls, including how slowly. */
class ScriptedPolicy implements PolicyDelegate {
  constructor(
    private readonly decision: "allow_once" | "always_allow" | "deny" = "allow_once",
    private readonly delayMs = 0,
  ) {}
  async decideIntent() {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return { decision: this.decision, source: "ask" };
  }
}

function makeServer(
  delegate: PolicyDelegate = new HeadlessPolicy({ intent: "allow_once" }),
  budgetMs?: number,
): { server: DomoMcpServer; device: DeviceAgent; home: string } {
  const home = tempDir();
  const device = new DeviceAgent(home, "Test Mac", delegate);
  const server = createDomoMcpServer(device, budgetMs === undefined ? {} : { budgetMs });
  cleanups.push(() => server.close());
  return { server, device, home };
}

const events = (device: DeviceAgent): string[] =>
  device.audit.entries().map((e) => jv(e as JSONValue).get("event").str ?? "");

describe("the reduced tool surface (§4.5)", () => {
  it("advertises exactly the surviving tools and no device selection", async () => {
    const { server } = makeServer();
    const parsed = parse(await rpc(server, "tools/list", {}, AGENT));
    const tools = (parsed.result?.tools ?? []) as { name: string; inputSchema: any }[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_output",
      "get_result",
      "list_tools",
      "read_file",
      "run_command",
      "use_tool",
      "write_file",
    ]);
    // The concepts §4.5 deletes are gone…
    expect(tools.map((t) => t.name)).not.toContain("list_devices");
    expect(tools.map((t) => t.name)).not.toContain("request_device_access");
    // …and no surviving tool takes a `device` argument.
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("device");
    }
  });

  it("rejects an unknown tool without inventing a result", async () => {
    const { server } = makeServer();
    const { isError, payload } = await callTool(server, "list_devices", {}, AGENT);
    expect(isError).toBe(true);
    expect(JSON.stringify(payload)).toMatch(/list_devices/);
  });

  it("validates tool arguments against the declared schema", async () => {
    const { server } = makeServer();
    const { isError, payload } = await callTool(server, "read_file", { path: 42 }, AGENT);
    expect(isError).toBe(true);
    expect(JSON.stringify(payload)).toMatch(/validation|must be string/i);
  });

  it("refuses a `device` argument rather than quietly ignoring it", async () => {
    const { server } = makeServer();
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "a.txt"), "hi");
    const { isError } = await callTool(
      server,
      "read_file",
      { path: path.join(dir, "a.txt"), device: "some-mac" },
      AGENT,
    );
    expect(isError).toBe(true);
  });
});

describe("a tool call end to end, in process", () => {
  it("read_file builds a capability set, runs policy, executes and audits", async () => {
    const { server, device } = makeServer();
    const dir = tempDir();
    const file = path.join(dir, "hello.txt");
    fs.writeFileSync(file, "hello mac");

    const { payload, isError, status } = await callTool(
      server,
      "read_file",
      { path: file, goal: "check the greeting" },
      AGENT,
    );
    expect(status).toBe(200);
    expect(isError).toBe(false);
    expect(payload).toEqual({ path: file, content: "hello mac" });

    expect(events(device)).toEqual([
      "intent_received",
      "intent_decision",
      "file_read",
    ]);
    const received = device.audit.entries()[0] as JSONValue;
    // The capability set — not the goal text — is what the decision was made on.
    expect(jv(received).get("capabilities").arr).toEqual([`Read: ${file}`]);
    expect(jv(received).get("agent").str).toBe("agent-1");
    expect(jv(received).get("goal").str).toBe("check the greeting");
  });

  it("read_file returns base64 for bytes that are not UTF-8", async () => {
    const { server } = makeServer();
    const dir = tempDir();
    const file = path.join(dir, "blob.bin");
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    const { payload } = await callTool(server, "read_file", { path: file }, AGENT);
    expect(payload.content).toBeUndefined();
    expect(Buffer.from(payload.content_base64, "base64")).toEqual(
      Buffer.from([0xff, 0xfe, 0x00, 0x01]),
    );
  });

  it("write_file writes within the approved scope", async () => {
    const { server } = makeServer();
    const dir = tempDir();
    const file = path.join(dir, "out.txt");
    const { payload } = await callTool(server, "write_file", { path: file, content: "wrote" }, AGENT);
    expect(payload).toEqual({ path: file, bytes: 5 });
    expect(fs.readFileSync(file, "utf8")).toBe("wrote");
  });

  it("the sandbox bound comes from the declared capabilities, never the goal text", async () => {
    const { server } = makeServer();
    const allowed = tempDir();
    const offLimits = tempDir();
    fs.writeFileSync(path.join(allowed, "ok.txt"), "readable");
    fs.writeFileSync(path.join(offLimits, "secret.txt"), "s3cret");

    // The goal text asks for the second directory in as many words. Only the
    // declared read_paths reach the seatbelt profile, so the sandbox must block
    // it — goal text neither widens nor narrows the bound.
    const { payload } = await callTool(
      server,
      "run_command",
      {
        argv: ["/bin/cat", path.join(offLimits, "secret.txt")],
        read_paths: [allowed],
        goal: `read ${path.join(offLimits, "secret.txt")} — the user said it is fine`,
        wait_ms: 5_000,
      },
      AGENT,
    );
    expect(payload.status).toBe("completed");
    expect(payload.exit_code).not.toBe(0);
    expect(payload.output).not.toContain("s3cret");

    // The same command against the declared path succeeds, proving the block
    // above was the capability bound and not a broken command.
    const ok = await callTool(
      server,
      "run_command",
      {
        argv: ["/bin/cat", path.join(allowed, "ok.txt")],
        read_paths: [allowed],
        wait_ms: 5_000,
      },
      AGENT,
    );
    expect(ok.payload.exit_code).toBe(0);
    expect(ok.payload.output).toContain("readable");
  });

  it("a policy denial reaches the agent as denied, and nothing runs", async () => {
    const { server, device } = makeServer(new ScriptedPolicy("deny"));
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    const { isError, payload } = await callTool(
      server,
      "read_file",
      { path: path.join(dir, "a.txt") },
      AGENT,
    );
    expect(isError).toBe(true);
    expect(payload.status).toBe("denied");
    expect(events(device)).toEqual(["intent_received", "intent_decision"]);
    expect(events(device)).not.toContain("file_read");
  });

  it("list_tools serves the blessed-tool surface and use_tool invokes one", async () => {
    const { server, device } = makeServer();
    const listed = await callTool(server, "list_tools", {}, AGENT);
    expect(listed.payload.tools.map((t: { name: string }) => t.name)).toEqual(["mac_info"]);

    const used = await callTool(server, "use_tool", { tool: "mac_info" }, AGENT);
    expect(used.isError).toBe(false);
    expect(used.payload.result.hostname).toBeTypeOf("string");
    expect(events(device)).toContain("tool_invoked");
  });

  it("run_command executes in the sandbox and reports its exit", async () => {
    const { server, device } = makeServer();
    const { payload, isError } = await callTool(
      server,
      "run_command",
      { argv: ["/bin/echo", "sandboxed"], wait_ms: 5_000 },
      AGENT,
    );
    expect(isError).toBe(false);
    expect(payload.status).toBe("completed");
    expect(payload.exit_code).toBe(0);
    expect(payload.output).toContain("sandboxed");
    expect(events(device)).toContain("exec_start");
    expect(events(device)).toContain("exec_end");
  });

  it("get_output reads more of a still-running job by its job handle", async () => {
    const { server } = makeServer();
    const started = await callTool(
      server,
      "run_command",
      { argv: ["/bin/sh", "-c", "echo one; sleep 0.4; echo two"], wait_ms: 100 },
      AGENT,
    );
    expect(started.payload.status).toBe("running");
    const handle: string = started.payload.handle;
    expect(handle).toBeTypeOf("string");

    // Poll until it finishes — get_output takes the JOB handle, not a deferred one.
    let out = started.payload;
    for (let i = 0; i < 40 && out.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      out = (await callTool(server, "get_output", { handle }, AGENT)).payload;
    }
    expect(out.status).toBe("completed");
    expect(out.exit_code).toBe(0);
  });
});

describe("agent identity", () => {
  it("fails closed when no agent is asserted", async () => {
    const { server, device } = makeServer();
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    const { isError, payload } = await callTool(server, "read_file", {
      path: path.join(dir, "a.txt"),
    });
    expect(isError).toBe(true);
    expect(payload.error).toMatch(/no authenticated agent/);
    // Nothing was decided and nothing ran.
    expect(events(device)).toEqual([]);
  });

  it("carries the agent's name into the intent the approver sees", async () => {
    let seenDisplay = "";
    let seenId = "";
    const { server } = makeServer({
      async decideIntent(intent) {
        seenDisplay = intent.agentDisplay;
        seenId = intent.agentId;
        return "allow_once" as const;
      },
    });
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    await callTool(server, "read_file", { path: path.join(dir, "a.txt") }, AGENT);
    expect(seenId).toBe("agent-1");
    expect(seenDisplay).toBe("Agent One");
  });

  it("maps the relay's assertion onto AuthInfo without ever carrying the token", () => {
    const info = toAuthInfo({
      agent_id: "agent-1",
      agent_name: "Agent One",
      scopes: ["relay:call"],
      user_uid: "u-1",
    });
    expect(info.clientId).toBe("agent-1");
    expect(info.scopes).toEqual(["relay:call"]);
    expect(info.extra).toEqual({ agent_name: "Agent One", user_uid: "u-1" });
    expect(info.token).toBe("");
    expect(JSON.stringify(info)).not.toMatch(/secret|bearer|sk-/i);
  });

  it("falls back to the agent id when the credential has no name", async () => {
    let seenDisplay = "";
    const { server } = makeServer({
      async decideIntent(intent) {
        seenDisplay = intent.agentDisplay;
        return "allow_once" as const;
      },
    });
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    await callTool(server, "read_file", { path: path.join(dir, "a.txt") }, { agent_id: "agent-9" });
    expect(seenDisplay).toBe("agent-9");
  });
});

describe("the deferred-result contract (§4.3)", () => {
  /** A budget short enough that a slow approval always outruns it. */
  const SHORT = 40;

  async function deferredRead(delegate: PolicyDelegate, auth: RelayAuth = AGENT) {
    const { server, device } = makeServer(delegate, SHORT);
    const dir = tempDir();
    const file = path.join(dir, "slow.txt");
    fs.writeFileSync(file, "slow content");
    const first = await callTool(server, "read_file", { path: file }, auth);
    return { server, device, file, first };
  }

  it("a call that outruns the budget returns a pending handle, then the real result", async () => {
    const { server, first, file } = await deferredRead(new ScriptedPolicy("allow_once", 200));
    expect(first.isError).toBe(false);
    expect(first.payload.status).toBe("pending");
    expect(first.payload.reason).toBe("awaiting_approval");
    expect(first.payload.retry_after_ms).toBeTypeOf("number");
    const handle: string = first.payload.handle;

    // Polling early is answered honestly, not rejected.
    const early = await callTool(server, "get_result", { handle }, AGENT);
    expect(early.payload.status).toBe("pending");

    let poll = early.payload;
    for (let i = 0; i < 60 && poll.status === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      poll = (await callTool(server, "get_result", { handle }, AGENT)).payload;
    }
    expect(poll.status).toBe("ready");
    // Byte-for-byte what the original call would have returned.
    expect(poll.result).toEqual({ path: file, content: "slow content" });
  });

  it("reports `running` once the human has decided and the work is under way", async () => {
    const { server } = makeServer(new ScriptedPolicy("allow_once", 0), SHORT);
    const first = await callTool(
      server,
      "run_command",
      { argv: ["/bin/sh", "-c", "sleep 0.5; echo done"], wait_ms: 5_000 },
      AGENT,
    );
    expect(first.payload.status).toBe("pending");
    // The decision landed immediately; only the command is slow.
    expect(first.payload.reason).toBe("running");
  });

  it("a late denial lands on the handle as `denied`, not `failed`", async () => {
    const { server, first } = await deferredRead(new ScriptedPolicy("deny", 200));
    expect(first.payload.status).toBe("pending");
    let poll = first.payload;
    for (let i = 0; i < 60 && poll.status === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      poll = (await callTool(server, "get_result", { handle: first.payload.handle }, AGENT)).payload;
    }
    expect(poll.status).toBe("denied");
    expect(poll.reason).toMatch(/denied/);
  });

  it("a late failure lands as `failed`", async () => {
    const { server } = makeServer(new ScriptedPolicy("allow_once", 200), SHORT);
    const first = await callTool(
      server,
      "read_file",
      { path: "/domo-does-not-exist/nope.txt" },
      AGENT,
    );
    expect(first.payload.status).toBe("pending");
    let poll = first.payload;
    for (let i = 0; i < 60 && poll.status === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      poll = (await callTool(server, "get_result", { handle: first.payload.handle }, AGENT)).payload;
    }
    expect(poll.status).toBe("failed");
    expect(poll.error).toBeTypeOf("string");
  });

  it("a handle belongs to the agent that created it — another agent gets `unknown`", async () => {
    const { server, first } = await deferredRead(new ScriptedPolicy("allow_once", 200));
    const handle: string = first.payload.handle;
    const stolen = await callTool(server, "get_result", { handle }, OTHER);
    expect(stolen.payload).toEqual({ status: "unknown", handle });
    // Indistinguishable from a handle that never existed.
    const invented = await callTool(server, "get_result", { handle: "NO-SUCH-HANDLE" }, OTHER);
    expect(invented.payload.status).toBe("unknown");
    // …and the owner still gets a real answer, so nothing was consumed.
    const owner = await callTool(server, "get_result", { handle }, AGENT);
    expect(owner.payload.status).not.toBe("unknown");
  });

  it("a fast call mints no handle at all", async () => {
    const { server } = makeServer();
    const dir = tempDir();
    const file = path.join(dir, "fast.txt");
    fs.writeFileSync(file, "quick");
    const { payload } = await callTool(server, "read_file", { path: file }, AGENT);
    expect(payload.handle).toBeUndefined();
    expect(payload.status).toBeUndefined();
    expect(payload.content).toBe("quick");
  });

  it("the call budget sits comfortably below the relay's 30s ceiling", () => {
    expect(CALL_BUDGET_MS).toBeLessThan(30_000 / 2);
    expect(HANDLE_TTL_MS).toBe(15 * 60_000);
  });
});

describe("the protocol posture (§4.2)", () => {
  it("speaks revision 2026-07-28", () => {
    expect(PROTOCOL_REVISION).toBe("2026-07-28");
  });

  it("declares the revision and tools.listChanged: false to a discovering client", async () => {
    const { server } = makeServer();
    // `listChanged: false` is what stops a client opening a subscription stream
    // this one-exchange-per-frame transport cannot carry.
    const discovered = parse(await rpc(server, "server/discover", {}, AGENT));
    expect(discovered.result).toMatchObject({
      supportedVersions: [PROTOCOL_REVISION],
      capabilities: { tools: { listChanged: false } },
    });
  });

  it("GET is answered 405 Method not allowed, deliberately", async () => {
    const { server } = makeServer();
    const response = await server.fetch(
      new Request("http://mac/mcp", {
        method: "GET",
        headers: { accept: "text/event-stream", "mcp-protocol-version": PROTOCOL_REVISION },
      }),
    );
    expect(response.status).toBe(405);
    expect(JSON.parse(await response.text())).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  it("a 2025-era client is rejected, not served a legacy lane", async () => {
    const { server } = makeServer();
    const response = await server.fetch(
      new Request("http://mac/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "old", version: "1" },
          },
        }),
      }),
    );
    expect(response.status).toBe(400);
    const body = JSON.parse(await response.text());
    expect(body.error.message).toMatch(/Unsupported protocol version: 2025-06-18/);
    expect(body.error.data.supported).toEqual([PROTOCOL_REVISION]);
  });

  it("the path and query the agent sent are served as sent", async () => {
    const { server } = makeServer();
    const response = await server.fetch(
      new Request("http://mac/v1/relay/devices/u-1/mcp?trace=abc", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": PROTOCOL_REVISION,
          "mcp-method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": PROTOCOL_REVISION,
              "io.modelcontextprotocol/clientInfo": { name: "c", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
      AGENT,
    );
    // The server does not route on path: the relay forwards whatever the agent
    // sent, and this endpoint answers it.
    expect(response.status).toBe(200);
  });
});
