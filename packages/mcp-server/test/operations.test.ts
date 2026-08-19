/**
 * Retry safety: one prompt and one side effect, however many times a
 * cooperating caller asks (design §6).
 *
 * The situation is ordinary. A response is lost — the socket dies, the relay
 * gives up — and the agent, correctly, tries again. Without a record of what it
 * already asked for, the retry asks the human a second time and writes the file
 * a second time; with one, it gets the first operation's state back.
 *
 * The properties that matter are all about what an id may NOT do: it may not
 * hide a caller reusing it for different work, it may not tell one agent
 * anything about another's, and it may not be recycled the moment a result
 * expires — a retry landing then would run the side effect again.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceAgent } from "@domo/device-core";
import {
  checkOperationId,
  createDomoMcpServer,
  OperationRecords,
  operationFingerprint,
  OPERATION_ID_PATTERN,
} from "@domo/mcp-server";
import { callTool } from "./client.js";

const ALICE = { agent_id: "sess_alice", agent_name: "Claude Code" };
const MALLORY = { agent_id: "sess_mallory", agent_name: "Claude Code" };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-ops-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A Mac that counts how often the human was asked. */
function makeServer(options: { budgetMs?: number; ttl?: number; now?: () => number } = {}) {
  const home = tempDir();
  const asked: string[] = [];
  const device = new DeviceAgent(home, "Test Mac", {
    decideIntent: async (intent) => {
      asked.push(intent.request);
      return "allow_once" as const;
    },
  });
  const server = createDomoMcpServer(device, {
    budgetMs: options.budgetMs ?? 30_000,
    operationTtlMs: options.ttl,
    operationTombstoneMs: options.ttl,
    now: options.now,
  });
  cleanups.push(() => server.close());
  return { server, device, asked, home };
}

describe("the operation id itself", () => {
  it("accepts 1-128 URL-safe characters and nothing else", () => {
    expect(checkOperationId("a")).toBe("a");
    expect(checkOperationId("A-Za-z0-9_-")).toBe("A-Za-z0-9_-");
    expect(checkOperationId("x".repeat(128))).toBe("x".repeat(128));
    for (const bad of [
      "",
      "x".repeat(129),
      "has space",
      "has/slash",
      "has:colon",
      "café",
      "a\nb",
      null,
      42,
      undefined,
    ]) {
      expect(() => checkOperationId(bad as never)).toThrow();
    }
    // The pattern is the contract, not an implementation detail of the check.
    expect(OPERATION_ID_PATTERN.test("ok_id-1")).toBe(true);
  });

  it("fingerprints the request without the name given to it", () => {
    // Same work, different id: still the same request. Otherwise a retry could
    // never match, and every id would be a fresh operation.
    const a = operationFingerprint("read_file", { path: "/x", operation_id: "one" });
    const b = operationFingerprint("read_file", { path: "/x", operation_id: "two" });
    expect(a).toBe(b);

    // Canonical, so a caller that reorders its keys still matches itself.
    expect(operationFingerprint("read_file", { path: "/x", goal: "g" })).toBe(
      operationFingerprint("read_file", { goal: "g", path: "/x" }),
    );

    // Different work, or the same work through a different tool, does not.
    expect(operationFingerprint("read_file", { path: "/x" })).not.toBe(
      operationFingerprint("read_file", { path: "/y" }),
    );
    expect(operationFingerprint("read_file", { path: "/x" })).not.toBe(
      operationFingerprint("write_file", { path: "/x" }),
    );
  });
});

describe("a retry after a lost response", () => {
  it("asks the human once and writes the file once", async () => {
    const { server, asked } = makeServer();
    const dir = tempDir();
    const file = path.join(dir, "note.txt");

    const first = await callTool(
      server,
      "write_file",
      { path: file, content: "one", operation_id: "op-write-1" },
      ALICE,
    );
    expect(first.isError).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("one");

    // The response never reached the agent. It retries, verbatim.
    fs.writeFileSync(file, "tampered-since");
    const retry = await callTool(
      server,
      "write_file",
      { path: file, content: "one", operation_id: "op-write-1" },
      ALICE,
    );

    expect(retry.isError).toBe(false);
    expect(retry.payload).toEqual(first.payload);
    // One prompt, and one write: the file still holds what the test put there
    // after the first call, because the second call did not run.
    expect(asked.length).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe("tampered-since");
  });

  it("hands a repeat of a still-pending operation the same handle, not a second prompt", async () => {
    // The disconnect/reconnect case: the call deferred, the socket died with
    // the envelope, and the agent retries while the human is still deciding.
    let approve = () => {};
    const waited = new Promise<void>((r) => {
      approve = () => r();
    });
    const home = tempDir();
    const asked: string[] = [];
    const device = new DeviceAgent(home, "Test Mac", {
      decideIntent: async (intent) => {
        asked.push(intent.request);
        await waited;
        return "allow_once" as const;
      },
    });
    const server = createDomoMcpServer(device, { budgetMs: 30 });
    cleanups.push(() => server.close());

    const dir = tempDir();
    const file = path.join(dir, "hello.txt");
    fs.writeFileSync(file, "the numbers");

    const first = await callTool(
      server,
      "read_file",
      { path: file, operation_id: "op-read-1" },
      ALICE,
    );
    expect(first.payload.status).toBe("pending");

    const retry = await callTool(
      server,
      "read_file",
      { path: file, operation_id: "op-read-1" },
      ALICE,
    );
    expect(retry.payload.status).toBe("pending");
    // The SAME handle: a second handle would mean a second operation, and the
    // human would be looking at a second dialog.
    expect(retry.payload.handle).toBe(first.payload.handle);
    expect(asked.length).toBe(1);

    approve();
    // And once the human answers, a further retry of the same operation gets
    // the RESULT — the current state, not a recording of the first reply.
    let latest = retry.payload;
    for (let i = 0; i < 200 && latest.status === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      latest = (
        await callTool(server, "read_file", { path: file, operation_id: "op-read-1" }, ALICE)
      ).payload;
    }
    expect(latest.status).toBe("ready");
    expect(latest.result.content).toBe("the numbers");
    expect(asked.length).toBe(1);
  });

  it("finds the operation by id when the handle was lost with the response", async () => {
    const { server } = makeServer({ budgetMs: 30 });
    const dir = tempDir();
    const file = path.join(dir, "hello.txt");
    fs.writeFileSync(file, "recovered");

    const first = await callTool(
      server,
      "read_file",
      { path: file, operation_id: "op-lost-handle" },
      ALICE,
    );
    // Whatever came back, the agent never saw it. It asks by the id it chose.
    let byId = (
      await callTool(server, "get_result", { operation_id: "op-lost-handle" }, ALICE)
    ).payload;
    for (let i = 0; i < 200 && byId.status === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      byId = (await callTool(server, "get_result", { operation_id: "op-lost-handle" }, ALICE))
        .payload;
    }
    expect(byId.status).toBe("ready");
    expect(JSON.stringify(byId)).toContain("recovered");
    // The id answered without the handle ever being used.
    expect(first.payload).toBeTruthy();
  });

  it("refuses a lookup that names both a handle and an id", async () => {
    const { server } = makeServer();
    const both = await callTool(
      server,
      "get_result",
      { handle: "H", operation_id: "op-1" },
      ALICE,
    );
    expect(both.isError).toBe(true);
    expect(JSON.stringify(both.payload)).toContain("not both");
  });
});

describe("an id reused for different work", () => {
  it("is a conflict, and leaves the original answerable", async () => {
    const { server, asked } = makeServer();
    const dir = tempDir();
    const first = path.join(dir, "a.txt");
    const second = path.join(dir, "b.txt");

    const original = await callTool(
      server,
      "write_file",
      { path: first, content: "a", operation_id: "op-same" },
      ALICE,
    );
    expect(original.isError).toBe(false);

    const clash = await callTool(
      server,
      "write_file",
      { path: second, content: "b", operation_id: "op-same" },
      ALICE,
    );
    expect(clash.isError).toBe(true);
    expect(clash.payload.status).toBe("conflict");
    expect(clash.payload.reason).toContain("op-same");
    // The conflicting call did nothing — not a partial write, not a prompt.
    expect(fs.existsSync(second)).toBe(false);
    expect(asked.length).toBe(1);

    // And the original operation still answers.
    const again = await callTool(
      server,
      "write_file",
      { path: first, content: "a", operation_id: "op-same" },
      ALICE,
    );
    expect(again.payload).toEqual(original.payload);
  });

  it("refuses an id that is not URL-safe, before anything runs", async () => {
    const { server, asked } = makeServer();
    const dir = tempDir();
    const file = path.join(dir, "c.txt");
    const bad = await callTool(
      server,
      "write_file",
      { path: file, content: "c", operation_id: "not safe/at all" },
      ALICE,
    );
    expect(bad.isError).toBe(true);
    expect(bad.payload.status).toBe("invalid_operation_id");
    expect(fs.existsSync(file)).toBe(false);
    expect(asked.length).toBe(0);
  });
});

describe("one agent's id says nothing about another's", () => {
  it("gives each agent its own operation under the same id", async () => {
    const { server, asked } = makeServer();
    const dir = tempDir();
    const mine = path.join(dir, "mine.txt");
    const theirs = path.join(dir, "theirs.txt");

    await callTool(server, "write_file", { path: mine, content: "m", operation_id: "shared" }, ALICE);
    // Same id, different agent, different work: an independent record, not a
    // conflict and not a replay of somebody else's answer.
    const other = await callTool(
      server,
      "write_file",
      { path: theirs, content: "t", operation_id: "shared" },
      MALLORY,
    );
    expect(other.isError).toBe(false);
    expect(fs.readFileSync(theirs, "utf8")).toBe("t");
    expect(asked.length).toBe(2);
  });

  it("answers a cross-agent lookup exactly as it answers an invented id", async () => {
    const { server } = makeServer();
    const dir = tempDir();
    const file = path.join(dir, "secret.txt");
    await callTool(
      server,
      "write_file",
      { path: file, content: "alice's", operation_id: "op-alice" },
      ALICE,
    );

    const stolen = await callTool(server, "get_result", { operation_id: "op-alice" }, MALLORY);
    const invented = await callTool(server, "get_result", { operation_id: "op-nobody" }, MALLORY);
    // Indistinguishable, down to the shape: an id is not an oracle for what
    // other agents are doing.
    expect(stolen.payload).toEqual({ status: "unknown", operation_id: "op-alice" });
    expect(JSON.stringify(stolen.payload)).toBe(
      JSON.stringify(invented.payload).replace("op-nobody", "op-alice"),
    );
    expect(JSON.stringify(stolen.payload)).not.toContain("alice's");
  });
});

describe("retention, then a tombstone", () => {
  it("answers, then expires, then frees the id — and never re-runs in between", async () => {
    let clock = 1_000_000;
    const { server, asked } = makeServer({ ttl: 60_000, now: () => clock });
    const dir = tempDir();
    const file = path.join(dir, "t.txt");

    const first = await callTool(
      server,
      "write_file",
      { path: file, content: "once", operation_id: "op-ttl" },
      ALICE,
    );
    expect(first.isError).toBe(false);
    expect(asked.length).toBe(1);

    // Inside retention: the result is still the answer.
    clock += 30_000;
    const inRetention = await callTool(
      server,
      "write_file",
      { path: file, content: "once", operation_id: "op-ttl" },
      ALICE,
    );
    expect(inRetention.payload).toEqual(first.payload);
    expect(asked.length).toBe(1);

    // Past retention, inside the tombstone: the result is gone, but the id is
    // still reserved — a retry landing here must not write the file again.
    fs.rmSync(file);
    clock += 40_000;
    const tombstoned = await callTool(
      server,
      "write_file",
      { path: file, content: "once", operation_id: "op-ttl" },
      ALICE,
    );
    expect(tombstoned.payload).toEqual({ status: "expired", operation_id: "op-ttl" });
    expect(fs.existsSync(file)).toBe(false);
    expect(asked.length).toBe(1);
    // A lookup agrees, rather than claiming never to have heard of it.
    expect(
      (await callTool(server, "get_result", { operation_id: "op-ttl" }, ALICE)).payload,
    ).toEqual({ status: "expired", operation_id: "op-ttl" });

    // Past the tombstone as well: the id is free, and using it is new work.
    clock += 70_000;
    const reused = await callTool(
      server,
      "write_file",
      { path: file, content: "again", operation_id: "op-ttl" },
      ALICE,
    );
    expect(reused.isError).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("again");
    expect(asked.length).toBe(2);
    // And a lookup for an id nobody holds is unknown once more.
    expect(
      (await callTool(server, "get_result", { operation_id: "op-never" }, ALICE)).payload,
    ).toEqual({ status: "unknown", operation_id: "op-never" });
  });
});

describe("the registry itself", () => {
  it("runs the work once for a repeat that arrives mid-flight", async () => {
    // Two callers racing: the record is registered before the work starts, so
    // the second finds it rather than starting a second attempt.
    const records = new OperationRecords();
    let runs = 0;
    let finish = (v: unknown) => void v;
    const work = () => {
      runs += 1;
      return new Promise<never>((resolve) => {
        finish = resolve as never;
      });
    };
    const read = () => ({ status: "pending" });
    const first = records.run("a", "op", "fp", work, read as never);
    const second = records.run("a", "op", "fp", work, read as never);
    finish({ ok: true });
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(runs).toBe(1);
  });

  it("keeps namespaces apart and sweeps only what is past its tombstone", async () => {
    let clock = 0;
    const records = new OperationRecords(100, 100, () => clock);
    const read = () => ({ status: "unknown" });
    await records.run("a", "op", "fp", async () => ({ done: true }), read as never);
    await records.run("b", "op", "fp", async () => ({ done: true }), read as never);
    expect(records.size).toBe(2);

    clock = 150; // past retention, inside the tombstone
    expect(records.lookupState("a", "op", read as never)).toEqual({
      status: "expired",
      operation_id: "op",
    });
    expect(records.size).toBe(2);

    clock = 250; // past the tombstone
    expect(records.lookupState("a", "op", read as never)).toBeNull();
    expect(records.size).toBe(0);
  });
});

describe("a socket that dies, and the agent that comes back", () => {
  it("survives the reconnect with one prompt and one side effect", async () => {
    // The scripted disconnect/reconnect §6 is written for, driven through the
    // real relay client: the request arrives as a frame, the response goes out
    // on that exchange, the socket dies before anyone can be sure it landed,
    // and the agent retries the same operation on a NEW socket.
    const { RelayClient } = await import("@domo/relay-client");
    const home = tempDir();
    const asked: string[] = [];
    let approve = () => {};
    const waited = new Promise<void>((r) => {
      approve = () => r();
    });
    const device = new DeviceAgent(home, "Test Mac", {
      decideIntent: async (intent) => {
        asked.push(intent.request);
        await waited;
        return "allow_once" as const;
      },
    });
    const server = createDomoMcpServer(device, { budgetMs: 40 });
    cleanups.push(() => server.close());

    const dir = tempDir();
    const file = path.join(dir, "target.txt");

    /** A socket the relay is on the other end of. */
    const socket = () => {
      const sock = {
        sent: [] as Record<string, unknown>[],
        onLine: null as ((line: Buffer) => void) | null,
        onClose: null as (() => void) | null,
        startReading() {},
        sendLine(line: Buffer) {
          sock.sent.push(JSON.parse(line.toString("utf8")) as Record<string, unknown>);
        },
        close() {},
        push(frame: unknown) {
          sock.onLine!(Buffer.from(JSON.stringify(frame), "utf8"));
        },
        answerFor(rid: string) {
          return sock.sent.find((f) => f.type === "relay.response" && f.rid === rid) as
            | { body: string }
            | undefined;
        },
      };
      return sock;
    };
    const frame = (rid: string) => ({
      type: "relay.request",
      rid,
      method: "POST",
      path: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "write_file",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "write_file",
          arguments: { path: file, content: "once", operation_id: "op-reconnect" },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
      auth: { agent_id: ALICE.agent_id, agent_name: ALICE.agent_name, scopes: [], user_uid: "u" },
    });
    const payloadOf = (answer: { body: string }) =>
      JSON.parse(JSON.parse(answer.body).result.content[0].text);

    let live = socket();
    const client = new RelayClient({
      url: "ws://relay.invalid/relay",
      credential: "plow_sk_test",
      serve: (request, auth, rid) => server.fetch(request, auth, rid),
      dial: () => ({ connect: async () => live as never }),
      random: () => 0,
    });
    cleanups.push(() => client.stop());
    await client.start();
    live.push({ type: "auth.challenge" });
    live.push({ type: "auth.ok", exchange_deadline_ms: 25_000, response_ack: true });

    // The call arrives, the human is slow, and a pending handle goes back.
    live.push(frame("RID-A"));
    for (let i = 0; i < 200 && !live.answerFor("RID-A"); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const first = payloadOf(live.answerFor("RID-A")!);
    expect(first.status).toBe("pending");
    expect(asked.length).toBe(1);

    // The socket dies with that answer possibly unread, and the Mac reconnects.
    live.onClose?.();
    const previous = live;
    live = socket();
    await new Promise((r) => setTimeout(r, 30));
    live.push({ type: "auth.challenge" });
    live.push({ type: "auth.ok", exchange_deadline_ms: 25_000, response_ack: true });
    expect(previous).not.toBe(live);

    // The agent retries the SAME operation on the new socket.
    approve();
    live.push(frame("RID-B"));
    for (let i = 0; i < 200 && !live.answerFor("RID-B"); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const retry = payloadOf(live.answerFor("RID-B")!);

    // One prompt, one write, and the retry is answered by the first operation
    // — as its handle while pending, or as its result once it landed.
    expect(asked.length).toBe(1);
    expect(retry.status === "pending" ? retry.handle : first.handle).toBe(first.handle);
    for (let i = 0; i < 200 && !fs.existsSync(file); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fs.readFileSync(file, "utf8")).toBe("once");

    // And the file is written exactly once: rewrite it, retry again, and it is
    // still what the test put there.
    fs.writeFileSync(file, "not-rewritten");
    live.push(frame("RID-C"));
    for (let i = 0; i < 200 && !live.answerFor("RID-C"); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fs.readFileSync(file, "utf8")).toBe("not-rewritten");
    expect(asked.length).toBe(1);
  });
});
