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
import {
  FRAME_REQUEST,
  FRAME_RESPONSE,
  HOP_BY_HOP,
  RELAY_CLIENT_KIND,
  RelayClient,
  stripHopByHop,
} from "@domo/relay-client";
import { WebSocket } from "ws";
import { FakeRelay } from "./fakeRelay.js";

const CREDENTIAL = "plow_sk_relay_connect_SECRET_VALUE";
const AGENT = { agent_id: "agent-1", agent_name: "Agent One", scopes: ["relay:call"], user_uid: "u-1" };

/**
 * The relay considers the device online when it sends auth.ok; the client marks
 * itself connected when it *receives* it. Tests that assert client state must
 * wait for the client, not for the relay.
 */
async function waitConnected(client: RelayClient, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!client.isConnected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!client.isConnected) throw new Error("client never reported connected");
}

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
    onAuthFailed?: (reason: string) => void;
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
    onAuthFailed: options.onAuthFailed,
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

});

describe("the handshake", () => {
  it("completes plow's challenge → auth → auth.ok, under a constant client kind", async () => {
    const { relay, client } = await stack();
    await client.start();
    await relay.waitForDevice();
    await waitConnected(client);

    const types = relay.received.map((f) => f.type);
    expect(types[0]).toBe("auth");
    // No `ready`: our wire contract has no such frame, and the relay logs one
    // as an unknown type. We do not send what nobody reads.
    expect(types).not.toContain("ready");
    expect(relay.unknownFrameTypes).toEqual([]);
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

});

describe("reconnection", () => {
  it("comes back after the relay drops the socket, and serves again", async () => {
    const { relay, client, statuses } = await stack();
    await client.start();
    await relay.waitForDevice();
    await waitConnected(client);
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
    await waitConnected(client);
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

  it("REJECTS a binary frame, as starlette's receive_text does", async () => {
    // The bug this stand-in failed to catch: we sent binary frames, the real
    // relay could not read them at all, and every test here passed because this
    // file decoded the bytes regardless of opcode.
    const relay = await FakeRelay.start({ expectCredential: CREDENTIAL });
    cleanups.push(() => relay.stop());
    const ws = new WebSocket(relay.url);
    cleanups.push(() => ws.terminate());
    const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));
    ws.on("message", (data: Buffer) => {
      if (JSON.parse(data.toString("utf8")).type !== "auth.challenge") return;
      // A perfectly valid auth frame — sent as BINARY.
      ws.send(
        Buffer.from(
          JSON.stringify({ type: "auth", token: CREDENTIAL, client_kind: RELAY_CLIENT_KIND }),
          "utf8",
        ),
        { binary: true },
      );
    });
    await closed;
    expect(relay.binaryFramesSeen).toBeGreaterThan(0);
    expect(relay.deviceOnline).toBe(false);
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

});


describe("a dial that resolves after stop()", () => {
  /** A socket that records what the client does to it. */
  function fakeConn(): Connection & { closed: boolean; reading: boolean } {
    return {
      onLine: null,
      onClose: null,
      closed: false,
      reading: false,
      startReading() {
        (this as unknown as { reading: boolean }).reading = true;
      },
      sendLine() {},
      close() {
        (this as unknown as { closed: boolean }).closed = true;
      },
    } as unknown as Connection & { closed: boolean; reading: boolean };
  }

  it("closes the socket instead of installing one nobody owns", async () => {
    // Sign-out calls `stop()`, which drops `conn` and stops reconnecting — but
    // it cannot close a connection that has not been handed over yet. A dial
    // still in flight would finish the handshake into an authenticated,
    // reading socket the client no longer tracks, serving agents with a
    // credential the app has already erased.
    const conn = fakeConn();
    let release = () => {};
    const dialing = new Promise<void>((r) => {
      release = () => r();
    });

    const client = new RelayClient({
      url: "ws://example.invalid/relay",
      credential: "plow_sk_test",
      serve: async () => new Response("no"),
      dial: () => ({ connect: async () => { await dialing; return conn; } }),
    });

    const starting = client.start();
    await client.stop();
    release();
    await starting;
    await new Promise((r) => setImmediate(r));

    expect(conn.reading).toBe(false);
    expect(conn.closed).toBe(true);
  });
});

describe("a credential the relay refuses", () => {
  it("stops instead of reconnecting forever, and says so once", async () => {
    // Reported live: the owner revoked this Mac's key in the Plow console. The
    // client treated 4001/auth_failed as just another dropped socket and
    // reconnected on backoff for as long as the app was open, hammering the
    // relay with a token it had already refused and telling the user nothing.
    // A refused credential cannot become valid by waiting, so it is terminal.
    const rejected: string[] = [];
    const lines: string[] = [];
    const { relay, client } = await stack({
      credential: "plow_a_credential_the_relay_will_refuse",
      onAuthFailed: (reason) => rejected.push(reason),
      log: (m) => lines.push(m),
    });

    await client.start();
    // Long enough that a backoff reconnect (base 500ms) would have fired.
    await new Promise((r) => setTimeout(r, 1_500));

    expect(rejected).toHaveLength(1);
    expect(relay.authFailures).toBe(1);
    expect(client.isConnected).toBe(false);
    // The proof it is not looping: one dial, and no reconnect was scheduled.
    expect(lines.filter((l) => l.startsWith("connecting to"))).toHaveLength(1);
    expect(lines.some((l) => l.includes("reconnecting in"))).toBe(false);
    // And nothing anywhere echoes the credential.
    expect(lines.join(" ")).not.toContain("plow_a_credential_the_relay_will_refuse");
  });
});
