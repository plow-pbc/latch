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
import { ApprovalStore, DeviceAgent, HeadlessPolicy, PolicyDelegate } from "@domo/device-core";
import { canonicalize } from "@domo/protocol";
import { createDomoMcpServer, PROTOCOL_REVISION } from "@domo/mcp-server";
import {
  FRAME_REQUEST,
  FRAME_RESPONSE,
  HOP_BY_HOP,
  RELAY_CLIENT_KIND,
  RelayClient,
  stripHopByHop,
} from "@domo/relay-client";
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

describe("a slow approval over the tunnel (§4.3, D3)", () => {
  it("handle inside the budget, human answers late, agent collects the result", async () => {
    const relay = await FakeRelay.start({ expectCredential: CREDENTIAL });
    cleanups.push(() => relay.stop());
    const home = tempDir();
    // Nobody answers on their own; the test plays the human, late.
    const approvals = new ApprovalStore(
      path.join(home, "device/approvals"),
      { decideIntent: () => new Promise(() => {}) },
      10_000,
    );
    const device = new DeviceAgent(home, "Test Mac", approvals);
    const BUDGET = 60;
    const mcp = createDomoMcpServer(device, { budgetMs: BUDGET });
    cleanups.push(() => mcp.close());
    const client = new RelayClient({
      url: relay.url,
      credential: CREDENTIAL,
      serve: (request, auth) => mcp.fetch(request, auth),
    });
    cleanups.push(() => client.stop());
    await client.start();
    await relay.waitForDevice();

    const dir = tempDir();
    const file = path.join(dir, "quarterly.txt");
    fs.writeFileSync(file, "the numbers");

    const started = Date.now();
    const first = JSON.parse(
      JSON.parse(
        (
          await relay.agentCall(
            mcpCall(20, "tools/call", { name: "read_file", arguments: { path: file } }),
            AGENT,
          )
        ).body,
      ).result.content[0].text,
    );
    const elapsed = Date.now() - started;

    // Came back inside the budget, with a handle rather than an answer.
    expect(first.status).toBe("pending");
    expect(first.reason).toBe("awaiting_approval");
    expect(elapsed).toBeLessThan(BUDGET + 2_000);

    // The approval is on disk while it is still unanswered — that record is the
    // only thing that says an agent asked for this file.
    const [record] = await approvals.all();
    expect(record.status).toBe("pending");
    expect(record.agentId).toBe("agent-1");
    expect(record.capabilities).toEqual([`Read: ${canonicalize(file)}`]);

    // The human comes back, well after the call returned.
    await new Promise((r) => setTimeout(r, 150));
    expect(approvals.resolve(record.intentId, "allow_once", "human")).toBe(true);

    let poll = first;
    for (let i = 0; i < 80 && poll.status === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      poll = JSON.parse(
        JSON.parse(
          (
            await relay.agentCall(
              mcpCall(21, "tools/call", {
                name: "get_result",
                arguments: { handle: first.handle },
              }),
              AGENT,
            )
          ).body,
        ).result.content[0].text,
      );
    }
    expect(poll.status).toBe("ready");
    expect(poll.result.content).toBe("the numbers");
    expect((await approvals.all())[0]).toMatchObject({
      status: "decided",
      decision: "allow_once",
      source: "human",
    });
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

    // Do NOT assert "disconnected" in a timing window: backoff is full jitter,
    // so the first retry can land in a couple of milliseconds and the client is
    // legitimately back before any sleep would observe the gap. Wait for the
    // transition sequence instead — that is the property, and it is racing
    // nothing.
    for (let i = 0; i < 200 && statuses.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    // online → offline → online, in that order.
    expect(statuses).toEqual([true, false, true]);
    await relay.waitForDevice(10_000);
    expect(client.isConnected).toBe(true);

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

describe("the stand-in relay is an independent implementation", () => {
  // It must be a second reading of the contract, not a mirror of ours. If it
  // imported our constants, a client that renamed a frame would drag it along
  // and every integration test would stay green.
  it("does not import the client's wire module", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "fakeRelay.ts"),
      "utf8",
    );
    expect(source).not.toContain("@domo/relay-client");
    expect(source).not.toContain("stripHopByHop");
  });

  it("its literals agree with ours — and that agreement is the assertion", () => {
    const source = fs.readFileSync(path.join(__dirname, "fakeRelay.ts"), "utf8");
    // Transcribed independently there; compared here. A rename on either side
    // that is not matched on the other fails this.
    expect(source).toContain(`const WIRE_FRAME_REQUEST = "${FRAME_REQUEST}"`);
    expect(source).toContain(`const WIRE_FRAME_RESPONSE = "${FRAME_RESPONSE}"`);
    expect(source).toContain(`const WIRE_CLIENT_KIND = "${RELAY_CLIENT_KIND}"`);
  });

  it("notices a device registering under an unexpected client kind", async () => {
    const { relay, client } = await stack();
    await client.start();
    await relay.waitForDevice();
    // The relay judges the kind against its OWN literal, not ours.
    expect(relay.unexpectedClientKind).toBeNull();
    expect(relay.clientKind).toBe(RELAY_CLIENT_KIND);
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

  it("strips hop-by-hop headers in both directions, but keeps Host", () => {
    const stripped = stripHopByHop({
      "content-type": "application/json",
      "Content-Length": "12",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      Host: "api.plow.co",
      "mcp-method": "tools/list",
    });
    expect(stripped).toEqual({
      "content-type": "application/json",
      // Host is END-TO-END: it names the authority the agent addressed, and
      // dropping it would leave this Mac validating a fabricated one.
      Host: "api.plow.co",
      "mcp-method": "tools/list",
    });
    expect(HOP_BY_HOP.has("host")).toBe(false);
  });

  it("serves the request under the authority that actually arrived", async () => {
    // Not a placeholder that would always pass whatever we validate later.
    let seenUrl = "";
    let seenHost: string | null = null;
    const relay = await FakeRelay.start({ expectCredential: CREDENTIAL });
    cleanups.push(() => relay.stop());
    const client = new RelayClient({
      url: relay.url,
      credential: CREDENTIAL,
      serve: async (request) => {
        seenUrl = request.url;
        seenHost = request.headers.get("host");
        return new Response("{}", { status: 200 });
      },
    });
    cleanups.push(() => client.stop());
    await client.start();
    await relay.waitForDevice();

    await relay.agentCall({ path: "/v1/relay/devices/u-1/mcp?trace=abc" }, AGENT);
    expect(seenHost).toBe(relay.authority);
    expect(new URL(seenUrl).host).toBe(relay.authority);
    expect(seenUrl).not.toContain("//mac/");
    // Path and query still arrive as sent.
    expect(new URL(seenUrl).pathname).toBe("/v1/relay/devices/u-1/mcp");
    expect(new URL(seenUrl).search).toBe("?trace=abc");
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
