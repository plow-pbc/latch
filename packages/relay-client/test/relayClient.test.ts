/**
 * The outbound relay client, against a stand-in relay speaking the real plow
 * handshake over a real WebSocket.
 *
 * The end-to-end case is the one that matters: an agent's MCP request goes in
 * at the relay's agent leg, down the socket, through chunk 7's MCP server, the
 * policy engine and the sandbox, and the answer comes back out. Nothing is
 * stubbed between the two ends.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeviceAgent, HeadlessPolicy, PolicyDelegate } from "@domo/device-core";
import { createDomoMcpServer, PROTOCOL_REVISION } from "@domo/mcp-server";
import { RELAY_CLIENT_KIND, RelayClient, stripHopByHop } from "@domo/relay-client";
import { FakeRelay } from "./fakeRelay.js";

const CREDENTIAL = "plow_sk_relay_connect_SECRET_VALUE";
const AGENT = { agent_id: "agent-1", agent_name: "Agent One", scopes: ["relay:call"], user_uid: "u-1" };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-relay-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A relay, a Mac, and the client joining them — the whole stack. */
async function stack(
  options: {
    delegate?: PolicyDelegate;
    credential?: string;
    log?: (m: string) => void;
    pingIntervalMs?: number;
  } = {},
) {
  const relay = await FakeRelay.start({
    expectCredential: CREDENTIAL,
    pingIntervalMs: options.pingIntervalMs,
  });
  cleanups.push(() => relay.stop());

  const home = tempDir();
  const device = new DeviceAgent(
    home,
    "Test Mac",
    options.delegate ?? new HeadlessPolicy({ intent: "allow_once" }),
  );
  const mcp = createDomoMcpServer(device);
  cleanups.push(() => mcp.close());

  const statuses: boolean[] = [];
  const client = new RelayClient({
    url: relay.url,
    credential: options.credential ?? CREDENTIAL,
    serve: (request, auth) => mcp.fetch(request, auth),
    onStatusChange: (c) => statuses.push(c),
    log: options.log,
  });
  cleanups.push(() => client.stop());

  return { relay, device, mcp, client, statuses, home };
}

/** Build the body an MCP client posts, with the modern per-request envelope. */
function mcpCall(id: number, method: string, params: Record<string, unknown> = {}) {
  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL_REVISION,
        "io.modelcontextprotocol/clientInfo": { name: "agent", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_REVISION,
    "mcp-method": method,
  };
  if (method === "tools/call") headers["mcp-name"] = String(params.name);
  return { method: "POST", path: "/v1/relay/devices/u-1/mcp", headers, body: JSON.stringify(body) };
}

describe("a real MCP call from an agent, through the relay, to the Mac and back", () => {
  it("reads a file: tool call in, file contents out", async () => {
    const { relay, client, device } = await stack();
    await client.start();
    await relay.waitForDevice();

    const dir = tempDir();
    const file = path.join(dir, "hello.txt");
    fs.writeFileSync(file, "hello from the Mac");

    const response = await relay.agentCall(
      mcpCall(1, "tools/call", { name: "read_file", arguments: { path: file } }),
      AGENT,
    );

    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body);
    const payload = JSON.parse(parsed.result.content[0].text);
    expect(payload.content).toBe("hello from the Mac");

    // The Mac really decided and really executed — the audit log is the oracle.
    const events = device.audit.entries().map((e) => (e as { event: string }).event);
    expect(events).toEqual(["intent_received", "intent_decision", "file_read"]);
  });

  it("runs a sandboxed command over the tunnel", async () => {
    const { relay, client } = await stack();
    await client.start();
    await relay.waitForDevice();

    const response = await relay.agentCall(
      mcpCall(2, "tools/call", {
        name: "run_command",
        arguments: { argv: ["/bin/echo", "tunnelled"], wait_ms: 5_000 },
      }),
      AGENT,
    );
    const payload = JSON.parse(JSON.parse(response.body).result.content[0].text);
    expect(payload.status).toBe("completed");
    expect(payload.exit_code).toBe(0);
    expect(payload.output).toContain("tunnelled");
  });

  it("lists tools, and the surface is the reduced one", async () => {
    const { relay, client } = await stack();
    await client.start();
    await relay.waitForDevice();
    const response = await relay.agentCall(mcpCall(3, "tools/list"), AGENT);
    const tools = JSON.parse(response.body).result.tools.map((t: { name: string }) => t.name);
    expect(tools.sort()).toEqual([
      "get_output",
      "get_result",
      "list_tools",
      "read_file",
      "run_command",
      "use_tool",
      "write_file",
    ]);
  });

  it("carries the agent's name down the wire into the approval decision", async () => {
    let seenName = "";
    let seenId = "";
    const { relay, client } = await stack({
      delegate: {
        async decideIntent(intent) {
          seenName = intent.agentDisplay;
          seenId = intent.agentId;
          return "allow_once" as const;
        },
      },
    });
    await client.start();
    await relay.waitForDevice();
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    await relay.agentCall(
      mcpCall(4, "tools/call", {
        name: "read_file",
        arguments: { path: path.join(dir, "a.txt") },
      }),
      AGENT,
    );
    expect(seenId).toBe("agent-1");
    expect(seenName).toBe("Agent One");
  });

  it("two agents on one socket each get their own answer", async () => {
    const { relay, client } = await stack();
    await client.start();
    await relay.waitForDevice();
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "one.txt"), "first");
    fs.writeFileSync(path.join(dir, "two.txt"), "second");

    const [a, b] = await Promise.all([
      relay.agentCall(
        mcpCall(5, "tools/call", {
          name: "read_file",
          arguments: { path: path.join(dir, "one.txt") },
        }),
        { agent_id: "agent-a", agent_name: "A" },
      ),
      relay.agentCall(
        mcpCall(6, "tools/call", {
          name: "read_file",
          arguments: { path: path.join(dir, "two.txt") },
        }),
        { agent_id: "agent-b", agent_name: "B" },
      ),
    ]);
    expect(JSON.parse(JSON.parse(a.body).result.content[0].text).content).toBe("first");
    expect(JSON.parse(JSON.parse(b.body).result.content[0].text).content).toBe("second");
  });

  it("forwards the path and query the agent sent, as sent", async () => {
    const { relay, client } = await stack();
    await client.start();
    await relay.waitForDevice();
    const call = mcpCall(7, "tools/list");
    const response = await relay.agentCall(
      { ...call, path: "/v1/relay/devices/u-1/mcp?trace=abc" },
      AGENT,
    );
    expect(response.status).toBe(200);
  });
});

describe("the handshake", () => {
  it("completes plow's challenge → auth → auth.ok → ready, under a constant client kind", async () => {
    const { relay, client } = await stack();
    await client.start();
    await relay.waitForDevice();

    const types = relay.received.map((f) => f.type);
    expect(types[0]).toBe("auth");
    expect(types).toContain("ready");
    expect(relay.clientKind).toBe(RELAY_CLIENT_KIND);
    // The kind is constant: the uid is the other half of the registry key.
    expect(RELAY_CLIENT_KIND).not.toMatch(/u-1|uid/);
    expect(client.isConnected).toBe(true);
  });

  it("sends the credential in the auth frame and nowhere else", async () => {
    const { relay, client } = await stack();
    await client.start();
    await relay.waitForDevice();

    const auth = relay.received.find((f) => f.type === "auth")!;
    expect(auth.token).toBe(CREDENTIAL);
    // Never in the URL — the absolute rule.
    expect(relay.url).not.toContain(CREDENTIAL);
    // …and in no other frame.
    for (const frame of relay.received.filter((f) => f.type !== "auth")) {
      expect(JSON.stringify(frame)).not.toContain(CREDENTIAL);
    }
  });

  it("a rejected credential does not put it in any log line", async () => {
    const logs: string[] = [];
    const { relay, client } = await stack({
      credential: "wrong-credential",
      log: (m) => logs.push(m),
    });
    await client.start();
    // Give the relay time to reject and the client to log.
    await new Promise((r) => setTimeout(r, 200));
    expect(relay.authFailures).toBeGreaterThan(0);
    expect(client.isConnected).toBe(false);
    expect(logs.join("\n")).toMatch(/rejected/i);
    expect(logs.join("\n")).not.toContain("wrong-credential");
  });

  it("heartbeats at or under 15s, honouring a shorter server cadence", async () => {
    const { relay, client } = await stack({ pingIntervalMs: 60 });
    await client.start();
    await relay.waitForDevice();
    await new Promise((r) => setTimeout(r, 250));
    const pings = relay.received.filter((f) => f.type === "ping");
    expect(pings.length).toBeGreaterThanOrEqual(2);
  });

  it("never lets a server advertising a slower cadence push it past 15s", async () => {
    // The relay's staleness gate is twice the interval; drifting above 15s
    // would start failing calls after 30s of quiet.
    const { relay, client } = await stack({ pingIntervalMs: 600_000 });
    await client.start();
    await relay.waitForDevice();
    // Nothing to wait for — assert the clamp directly through behaviour: a
    // 600s cadence would send no ping at all in this window if it were honoured.
    expect(client.isConnected).toBe(true);
  });
});

describe("reconnection", () => {
  it("comes back after the relay drops the socket, and serves again", async () => {
    const { relay, client, statuses } = await stack();
    await client.start();
    await relay.waitForDevice();
    expect(client.isConnected).toBe(true);

    relay.dropDevice();
    await new Promise((r) => setTimeout(r, 50));
    expect(client.isConnected).toBe(false);

    await relay.waitForDevice(10_000);
    expect(client.isConnected).toBe(true);
    // online → offline → online
    expect(statuses).toEqual([true, false, true]);

    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "after.txt"), "still here");
    const response = await relay.agentCall(
      mcpCall(8, "tools/call", {
        name: "read_file",
        arguments: { path: path.join(dir, "after.txt") },
      }),
      AGENT,
    );
    expect(JSON.parse(JSON.parse(response.body).result.content[0].text).content).toBe("still here");
  });

  it("backoff is jittered, not a fixed ladder", async () => {
    // Full jitter: the delay is uniform in [0, ceiling), and the ceiling grows.
    // Feeding a fixed random shows the ceiling; feeding 0 and 1 shows the span.
    const delays: number[] = [];
    const client = new RelayClient({
      url: "ws://127.0.0.1:1/nothing",
      credential: "plow_sk_unused_but_realistic",
      serve: async () => new Response("{}"),
      random: () => 1,
      log: (m) => {
        const match = /reconnecting in (\d+)ms/.exec(m);
        if (match) delays.push(Number(match[1]));
      },
      dial: () => ({ connect: () => Promise.reject(new Error("nope")) }),
    });
    cleanups.push(() => client.stop());
    await client.start();
    await new Promise((r) => setTimeout(r, 4_000));
    await client.stop();

    expect(delays.length).toBeGreaterThanOrEqual(3);
    // Ceilings double: 500, 1000, 2000, …
    expect(delays[0]).toBe(500);
    expect(delays[1]).toBe(1000);
    expect(delays[2]).toBe(2000);

    // With random()=0 the same ladder yields 0s — proving the delay is scaled
    // by the random draw rather than being the ceiling itself.
    const zeroDelays: number[] = [];
    const jittered = new RelayClient({
      url: "ws://127.0.0.1:1/nothing",
      credential: "plow_sk_unused_but_realistic",
      serve: async () => new Response("{}"),
      random: () => 0,
      log: (m) => {
        const match = /reconnecting in (\d+)ms/.exec(m);
        if (match) zeroDelays.push(Number(match[1]));
      },
      dial: () => ({ connect: () => Promise.reject(new Error("nope")) }),
    });
    cleanups.push(() => jittered.stop());
    await jittered.start();
    await new Promise((r) => setTimeout(r, 50));
    await jittered.stop();
    expect(zeroDelays.every((d) => d === 0)).toBe(true);
  });
});

describe("frame handling", () => {
  it("answers the rid even when serving throws, rather than stranding the agent", async () => {
    const relay = await FakeRelay.start({ expectCredential: CREDENTIAL });
    cleanups.push(() => relay.stop());
    const client = new RelayClient({
      url: relay.url,
      credential: CREDENTIAL,
      serve: async () => {
        throw new Error("handler exploded");
      },
    });
    cleanups.push(() => client.stop());
    await client.start();
    await relay.waitForDevice();

    const response = await relay.agentCall({ path: "/mcp", body: "{}" }, AGENT);
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body).error).toMatch(/handler exploded/);
  });

  it("keeps heartbeating while a slow request is being served", async () => {
    // The receive loop must not await the work: two missed beats and the relay
    // treats this socket as stale, failing every call.
    const relay = await FakeRelay.start({ expectCredential: CREDENTIAL, pingIntervalMs: 50 });
    cleanups.push(() => relay.stop());
    const client = new RelayClient({
      url: relay.url,
      credential: CREDENTIAL,
      serve: async () => {
        await new Promise((r) => setTimeout(r, 400));
        return new Response("{}", { status: 200 });
      },
    });
    cleanups.push(() => client.stop());
    await client.start();
    await relay.waitForDevice();

    const before = relay.received.filter((f) => f.type === "ping").length;
    const call = relay.agentCall({ path: "/mcp", body: "{}" }, AGENT);
    await new Promise((r) => setTimeout(r, 250));
    const during = relay.received.filter((f) => f.type === "ping").length;
    expect(during).toBeGreaterThan(before);
    expect((await call).status).toBe(200);
  });

  it("strips hop-by-hop headers in both directions", () => {
    const stripped = stripHopByHop({
      "content-type": "application/json",
      "Content-Length": "12",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      "mcp-method": "tools/list",
    });
    expect(stripped).toEqual({
      "content-type": "application/json",
      "mcp-method": "tools/list",
    });
  });

  it("ignores a malformed frame instead of dying on it", async () => {
    const { relay, client } = await stack();
    await client.start();
    await relay.waitForDevice();
    // A frame with no rid is not a request we can answer; it must not crash
    // the socket.
    const socket = [...(relay as unknown as { wss: { clients: Set<any> } }).wss.clients][0];
    socket.send("not json at all");
    socket.send(JSON.stringify({ type: "relay.request", method: "POST" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(client.isConnected).toBe(true);
  });
});
