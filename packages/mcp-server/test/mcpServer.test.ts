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
import { canonicalize, JSONValue, jv } from "@domo/protocol";
import {
  DENIAL_SOURCE_NO_CREDITS,
  DENIAL_SOURCE_NO_REVIEWER,
  DeviceAgent,
  HeadlessPolicy,
  MAX_FILE_BYTES,
  PolicyDelegate,
} from "@domo/device-core";
import {
  CALL_BUDGET_MS,
  createDomoMcpServer,
  DeferredResults,
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
    /** How it decided. Some sources carry an explanation to the caller. */
    private readonly source = "ask",
  ) {}
  async decideIntent() {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return { decision: this.decision, source: this.source };
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
      "plow_browser",
      "plow_browser_close",
      "plow_browser_open",
      "plow_browser_request",
      "plow_get_output",
      "plow_get_result",
      "plow_list_skills",
      "plow_read_file",
      "plow_read_skill",
      "plow_run_command",
      "plow_vault",
      "plow_write_file",
    ]);
    // The concepts §4.5 deletes are gone…
    expect(tools.map((t) => t.name)).not.toContain("list_devices");
    expect(tools.map((t) => t.name)).not.toContain("request_device_access");
    // …and no surviving tool takes a `device` argument.
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("device");
    }
  });

});

describe("a tool call end to end, in process", () => {
  it("plow_read_file builds a capability set, runs policy, executes and audits", async () => {
    const { server, device } = makeServer();
    const dir = tempDir();
    const file = path.join(dir, "hello.txt");
    fs.writeFileSync(file, "hello mac");

    const { payload, isError, status } = await callTool(
      server,
      "plow_read_file",
      { path: file, goal: "check the greeting" },
      AGENT,
    );
    expect(status).toBe(200);
    expect(isError).toBe(false);
    expect(payload).toEqual({ path: canonicalize(file), content: "hello mac" });

    expect(events(device)).toEqual([
      "intent_received",
      "intent_decision",
      "file_read",
    ]);
    const received = device.audit.entries()[0] as JSONValue;
    // The capability set — not the goal text — is what the decision was made on.
    expect(jv(received).get("capabilities").arr).toEqual([`Read: ${canonicalize(file)}`]);
    expect(jv(received).get("agent").str).toBe("agent-1");
    expect(jv(received).get("goal").str).toBe("check the greeting");
  });

  it("goal text cannot widen the sandbox: a path outside its permitted region is blocked", async () => {
    const { server } = makeServer();
    const allowed = tempDir();
    const offLimits = tempDir();
    fs.writeFileSync(path.join(allowed, "ok.txt"), "readable");
    fs.writeFileSync(path.join(offLimits, "secret.txt"), "s3cret");

    // What this proves, precisely: the goal text asks for the second directory
    // in as many words, and the command is still blocked. Goal text does not
    // reach the profile.
    //
    // What it does NOT prove: that declaring read_paths is what bounds reads.
    // It does not — the profile permits reads across $HOME regardless (see
    // docs/SANDBOX-BOUNDARY.md). These directories are under os.tmpdir(), i.e.
    // outside the permitted region, which is why the block happens at all. An
    // earlier version of this test claimed the stronger property and passed
    // only by that accident.
    const { payload } = await callTool(
      server,
      "plow_run_command",
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
      "plow_run_command",
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
      "plow_read_file",
      { path: path.join(dir, "a.txt") },
      AGENT,
    );
    expect(isError).toBe(true);
    expect(payload.status).toBe("denied");
    // A human saying no is between them and their Mac: it explains nothing, and
    // in particular must not read like an account problem.
    expect(payload.reason).toBe("the owner of this Mac denied the request");
    expect(JSON.stringify(payload)).not.toMatch(/credit|balance|plow/i);
    expect(events(device)).toEqual(["intent_received", "intent_decision"]);
    expect(events(device)).not.toContain("file_read");
  });

  // An agent must be able to tell a standing condition — "nobody could review
  // this" — from "the owner decided against it", because only the first is
  // something a human can go and fix. Each denial source carries its own fixed
  // sentence, and the shared contract is the interesting half: it denies, it
  // runs nothing, and the sentence is fixed text that cannot carry anything
  // upstream back to the caller.
  const explainedDenials = [
    { name: "out of credits", source: DENIAL_SOURCE_NO_CREDITS, fragments: [/out of credits/, /could not run/] },
    {
      name: "a reviewer that does not exist",
      source: DENIAL_SOURCE_NO_REVIEWER,
      fragments: [/no credential/, /could not run/],
    },
  ];

  for (const c of explainedDenials) {
    it(`${c.name} is distinguishable by the calling agent, and still runs nothing`, async () => {
      const { server, device } = makeServer(new ScriptedPolicy("deny", 0, c.source));
      const dir = tempDir();
      fs.writeFileSync(path.join(dir, "a.txt"), "x");
      const { isError, payload } = await callTool(
        server,
        "plow_read_file",
        { path: path.join(dir, "a.txt") },
        AGENT,
      );
      expect(isError).toBe(true);
      expect(payload.status).toBe("denied");
      for (const fragment of c.fragments) expect(payload.reason).toMatch(fragment);
      // Not the sentence a human pressing Deny produces.
      expect(payload.reason).not.toBe("the owner of this Mac denied the request");
      expect(events(device)).not.toContain("file_read");
      // Fixed text for exactly this reason: nothing upstream, and nothing about
      // the account, can reach a caller through it.
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toMatch(/plow_sk|sk-ant|Bearer/i);
      expect(serialized).not.toMatch(/https?:\/\//);
      expect(serialized).not.toMatch(/\bu_[a-z0-9]/i); // account uid shape
    });
  }

});

describe("agent identity", () => {
  it("fails closed when no agent is asserted", async () => {
    const { server, device } = makeServer();
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    const { isError, payload } = await callTool(server, "plow_read_file", {
      path: path.join(dir, "a.txt"),
    });
    expect(isError).toBe(true);
    expect(payload.error).toMatch(/no authenticated agent/);
    // Nothing was decided and nothing ran.
    expect(events(device)).toEqual([]);
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

});

describe("the deferred-result contract (§4.3)", () => {
  /** A budget short enough that a slow approval always outruns it. */
  const SHORT = 40;

  async function deferredRead(delegate: PolicyDelegate, auth: RelayAuth = AGENT) {
    const { server, device } = makeServer(delegate, SHORT);
    const dir = tempDir();
    const file = path.join(dir, "slow.txt");
    fs.writeFileSync(file, "slow content");
    const first = await callTool(server, "plow_read_file", { path: file }, auth);
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
    const early = await callTool(server, "plow_get_result", { handle }, AGENT);
    expect(early.payload.status).toBe("pending");

    let poll = early.payload;
    for (let i = 0; i < 60 && poll.status === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      poll = (await callTool(server, "plow_get_result", { handle }, AGENT)).payload;
    }
    expect(poll.status).toBe("ready");
    // Byte-for-byte what the original call would have returned.
    expect(poll.result).toEqual({ path: canonicalize(file), content: "slow content" });
  });

  it("a handle belongs to the agent that created it — another agent gets `unknown`", async () => {
    const { server, first } = await deferredRead(new ScriptedPolicy("allow_once", 200));
    const handle: string = first.payload.handle;
    const stolen = await callTool(server, "plow_get_result", { handle }, OTHER);
    expect(stolen.payload).toEqual({ status: "unknown", handle });
    // Indistinguishable from a handle that never existed.
    const invented = await callTool(server, "plow_get_result", { handle: "NO-SUCH-HANDLE" }, OTHER);
    expect(invented.payload.status).toBe("unknown");
    // …and the owner still gets a real answer, so nothing was consumed.
    const owner = await callTool(server, "plow_get_result", { handle }, AGENT);
    expect(owner.payload.status).not.toBe("unknown");
  });

  it("the call budget leaves the relay's 25s exchange ten seconds to deliver", () => {
    // The relay's pending future times out at 25 SECONDS. What is left after
    // the budget is not slack: it is the time registering the handle, framing
    // the response and matching it to the waiting exchange all have to fit in.
    const RELAY_TIMEOUT_MS = 25_000;
    const DELIVERY_MARGIN_MS = 10_000;
    // Pinned, not just bounded: a margin check alone passes for any budget
    // SHORTER than this one too, and the point of the number is that a human
    // gets the whole fifteen seconds to answer inside the original call.
    expect(CALL_BUDGET_MS).toBe(15_000);
    expect(RELAY_TIMEOUT_MS - CALL_BUDGET_MS).toBeGreaterThanOrEqual(DELIVERY_MARGIN_MS);
    expect(HANDLE_TTL_MS).toBe(15 * 60_000);
  });
});

describe("the protocol posture (§4.2)", () => {
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

});

describe("review findings", () => {
  // 1 — subscriptions/listen opens an SSE stream the tunnel cannot carry, and
  // responseMode:"json" does not disable it. Refusal is the only thing that does.
  describe("subscriptions/listen is refused outright", () => {
    it("is refused, with the caller's id, and never streams", async () => {
      const { server } = makeServer();
      const raw = await rpc(
        server,
        "subscriptions/listen",
        { notifications: ["notifications/tools/list_changed"] },
        AGENT,
      );
      expect(raw.status).toBe(404);
      // Not an SSE stream: a single JSON body.
      expect(raw.headers["content-type"]).toContain("application/json");
      expect(raw.headers["content-type"]).not.toContain("text/event-stream");
      const parsed = parse(raw);
      expect(parsed.error?.code).toBe(-32601);
      expect(parsed.error?.message).toMatch(/not supported/i);
      // The refusal echoes the caller's id rather than inventing one.
      expect(JSON.parse(raw.body).id).toBe(raw.sentId);
    });

  });

  // 2 — the isolation key must be a non-empty string. Truthy non-strings would
  // otherwise reach policy and execution as a key that cannot be compared.
  describe("the identity guard requires a non-empty string id", () => {
    const malformed: [string, unknown][] = [
      ["an array", []],
      ["a non-empty array", ["agent-1"]],
      ["an object", {}],
      ["a number", 42],
      ["zero", 0],
      ["a boolean", true],
      ["null", null],
      ["an empty string", ""],
      ["whitespace only", "   "],
    ];
    for (const [label, agent_id] of malformed) {
      it(`rejects ${label}`, async () => {
        const { server, device } = makeServer();
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, "a.txt"), "x");
        const { isError, payload } = await callTool(
          server,
          "plow_read_file",
          { path: path.join(dir, "a.txt") },
          { agent_id } as unknown as RelayAuth,
        );
        expect(isError).toBe(true);
        expect(payload.error).toMatch(/no authenticated agent/);
        // Nothing was decided and nothing ran.
        expect(events(device)).toEqual([]);
      });
    }

    it("a non-string agent name is dropped rather than carried into the dialog", async () => {
      let seenDisplay = "";
      const { server } = makeServer({
        async decideIntent(intent) {
          seenDisplay = intent.agentDisplay;
          return "allow_once" as const;
        },
      });
      const dir = tempDir();
      fs.writeFileSync(path.join(dir, "a.txt"), "x");
      await callTool(server, "plow_read_file", { path: path.join(dir, "a.txt") }, {
        agent_id: "agent-7",
        agent_name: { evil: true },
      } as unknown as RelayAuth);
      expect(seenDisplay).toBe("agent-7");
    });

    // Deliberate: the static manifest carries nothing about this Mac, and the
    // relay refuses an unauthenticated caller before it reaches us.
    it("tools/list and server/discover are served without identity, deliberately", async () => {
      const { server } = makeServer();
      const anonymous = parse(await rpc(server, "tools/list", {}));
      const identified = parse(await rpc(server, "tools/list", {}, AGENT));
      expect(anonymous.result?.tools).toEqual(identified.result?.tools);
      expect(parse(await rpc(server, "server/discover", {})).result).toBeDefined();
    });
  });

  // 3 — synchronous filesystem work would starve the budget timer, so the call
  // returns late, after the relay has already given up.
  describe("the call budget can actually bound filesystem work", () => {
    it("a read over the size ceiling is refused rather than blocking", async () => {
      const { server } = makeServer();
      const dir = tempDir();
      const big = path.join(dir, "big.bin");
      const fd = fs.openSync(big, "w");
      fs.ftruncateSync(fd, MAX_FILE_BYTES + 1);
      fs.closeSync(fd);
      const { isError, payload } = await callTool(server, "plow_read_file", { path: big }, AGENT);
      expect(isError).toBe(true);
      expect(JSON.stringify(payload)).toMatch(/single-call limit/);
    });

    it("the budget timer still fires while a read is in flight", async () => {
      // With a synchronous read the event loop is blocked and the budget timer
      // cannot fire, so the call returns its result late instead of deferring.
      // Async filesystem work lets the budget win, which is the whole point.
      const { server } = makeServer(new ScriptedPolicy("allow_once", 60), 20);
      const dir = tempDir();
      const file = path.join(dir, "a.txt");
      fs.writeFileSync(file, "content");
      const { payload } = await callTool(server, "plow_read_file", { path: file }, AGENT);
      expect(payload.status).toBe("pending");
    });
  });

  // 4 — the approval dialog's whole value is that the human sees what will
  // actually happen.
  describe("the human approves the path that actually executes", () => {
    it("a symlink is resolved before the approver sees it", async () => {
      let approved: string[] = [];
      const { server, device } = makeServer({
        async decideIntent(intent) {
          approved = intent.capabilities.flatMap((c) => c.paths ?? []);
          return "allow_once" as const;
        },
      });
      const realDir = tempDir();
      const linkDir = tempDir();
      const target = path.join(realDir, "id_rsa");
      fs.writeFileSync(target, "PRIVATE KEY");
      const innocuous = path.join(linkDir, "report.txt");
      fs.symlinkSync(target, innocuous);

      const { payload } = await callTool(server, "plow_read_file", { path: innocuous }, AGENT);

      // The approver saw the real target, not the innocuous name.
      expect(approved).toEqual([canonicalize(target)]);
      expect(approved[0]).not.toBe(innocuous);
      // The audit record says the same thing.
      const received = device.audit.entries()[0] as JSONValue;
      expect(jv(received).get("capabilities").arr).toEqual([`Read: ${canonicalize(target)}`]);
      // And the result names the resolved path too.
      expect(payload.path).toBe(canonicalize(target));
    });

    it("swapping the symlink after approval cannot redirect the read", async () => {
      const realDir = tempDir();
      const decoy = path.join(realDir, "harmless.txt");
      const secret = path.join(realDir, "secret.txt");
      fs.writeFileSync(decoy, "harmless");
      fs.writeFileSync(secret, "s3cret");
      const linkDir = tempDir();
      const link = path.join(linkDir, "report.txt");
      fs.symlinkSync(decoy, link);

      // Re-point the symlink at the secret the instant the decision lands.
      const { server } = makeServer({
        async decideIntent() {
          fs.unlinkSync(link);
          fs.symlinkSync(secret, link);
          return "allow_once" as const;
        },
      });

      const { payload } = await callTool(server, "plow_read_file", { path: link }, AGENT);
      // The capability froze the resolved path, so execution never re-follows
      // the link: the swap is inert.
      expect(payload.path).toBe(canonicalize(decoy));
      expect(payload.content).toBe("harmless");
      expect(payload.content).not.toContain("s3cret");
    });

    it("plow_run_command's declared bounds are resolved before approval too", async () => {
      let approved: string[] = [];
      let cwd: string | undefined;
      const { server } = makeServer({
        async decideIntent(intent) {
          approved = intent.capabilities.flatMap((c) => c.paths ?? []);
          cwd = intent.capabilities.find((c) => c.kind === "process.exec")?.cwd;
          return "allow_once" as const;
        },
      });
      const realDir = tempDir();
      const linkDir = tempDir();
      const link = path.join(linkDir, "work");
      fs.symlinkSync(realDir, link);
      await callTool(
        server,
        "plow_run_command",
        { argv: ["/bin/echo", "x"], read_paths: [link], cwd: link, wait_ms: 3_000 },
        AGENT,
      );
      expect(approved).toEqual([canonicalize(realDir)]);
      expect(cwd).toBe(canonicalize(realDir));
    });
  });

  // 5 — the wait_ms cap does not produce a direct job handle. Pin what really
  // happens so the claim cannot drift back to the wrong one.
  describe("a command outrunning the budget defers, then yields its job handle", () => {
    it("takes two hops: pending handle, then a ready payload containing the job handle", async () => {
      const { server, device } = makeServer(new ScriptedPolicy("allow_once", 0), 30);
      const first = await callTool(
        server,
        "plow_run_command",
        { argv: ["/bin/sh", "-c", "sleep 0.4; echo done"], wait_ms: 60_000 },
        AGENT,
      );
      // Hop one: NOT a job handle — a deferred one.
      expect(first.payload.status).toBe("pending");
      expect(first.payload.reason).toBe("running");
      expect(first.payload.retry_after_ms).toBeTypeOf("number");
      const deferredHandle: string = first.payload.handle;

      // Hop two: the ready payload is the plow_run_command result, and the job
      // handle is inside it.
      let poll = first.payload;
      for (let i = 0; i < 80 && poll.status === "pending"; i++) {
        await new Promise((r) => setTimeout(r, 25));
        poll = (await callTool(server, "plow_get_result", { handle: deferredHandle }, AGENT)).payload;
      }
      expect(poll.status).toBe("ready");
      // The ready payload is the plow_run_command result. Because wait_ms is capped
      // at the budget, that result is itself the "still running, here is a job
      // handle" answer — so the agent ends up with TWO handles for one command.
      expect(poll.result.status).toBe("running");
      expect(poll.result.handle).toBeTypeOf("string");
      expect(poll.result.handle).not.toBe(deferredHandle);

      // Hop three, in practice: the inner handle is the JOB handle plow_get_output
      // takes, and that is where the output actually arrives.
      let out = poll.result;
      for (let i = 0; i < 80 && out.status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 25));
        out = (await callTool(server, "plow_get_output", { handle: poll.result.handle }, AGENT)).payload;
      }
      expect(out.status).toBe("completed");
      expect(out.exit_code).toBe(0);
      expect(out.output).toContain("done");

      // The audit closes the run out exactly once, keyed to the intent — not
      // once per get_output poll, and never as a handle-only orphan.
      await callTool(server, "plow_get_output", { handle: poll.result.handle }, AGENT);
      await callTool(server, "plow_get_output", { handle: poll.result.handle }, AGENT);
      const entries = device.audit.entries();
      const ends = entries.filter((e) => jv(e).get("event").str === "exec_end");
      expect(ends).toHaveLength(1);
      expect(jv(ends[0]!).get("exit_code").int).toBe(0);
      const received = entries.find((e) => jv(e).get("event").str === "intent_received");
      expect(jv(ends[0]!).get("intentId").str).toBe(jv(received!).get("intentId").str);
    });
  });

  // 6 — an agent that discards its handles never calls get(), so without a
  // sweep on insert the terminal payloads accumulate forever.
  describe("deferred entries are swept on insert as well as on read", () => {
    it("drops long-expired entries when a new handle is registered", async () => {
      let now = 1_000_000;
      const store = new DeferredResults(10, HANDLE_TTL_MS, () => now);
      const slow = () => new Promise<JSONValue>((r) => setTimeout(() => r({ ok: true }), 40));

      const first = (await store.run("agent-1", slow)) as { handle: string };
      expect(first.handle).toBeTypeOf("string");
      await new Promise((r) => setTimeout(r, 60));
      // Still retrievable inside the TTL.
      expect((store.get("agent-1", first.handle) as { status: string }).status).toBe("ready");

      expect(store.size).toBe(1);

      // Walk past expiry + the tombstone window, then register a new handle
      // WITHOUT ever reading the old one — an agent that discards its handles
      // never calls get(), which is the whole point of the finding.
      now += HANDLE_TTL_MS * 2 + 1;
      const second = (await store.run("agent-1", slow)) as { handle: string };
      // Checked before any get(), because get() sweeps too and would prove
      // nothing about the insert path.
      expect(store.size).toBe(1);
      await new Promise((r) => setTimeout(r, 60));
      expect(store.get("agent-1", first.handle)).toEqual({
        status: "unknown",
        handle: first.handle,
      });
      expect((store.get("agent-1", second.handle) as { status: string }).status).toBe("ready");
    });
  });
});

// §4.4: jobs, handles, approvals and output cursors are scoped to agent_id —
// never to the name, which is nullable and not unique. The identical-name case
// is the one that catches a system that drifted to keying on the wrong field.
describe("per-agent isolation (§4.4)", () => {
  const ALICE: RelayAuth = { agent_id: "sess_alice", agent_name: "Claude Code" };
  // Same display name, different credential. Two people can name their agents
  // the same thing, and Session.name is not unique.
  const MALLORY: RelayAuth = { agent_id: "sess_mallory", agent_name: "Claude Code" };

  async function startJob(server: DomoMcpServer, auth: RelayAuth, marker: string) {
    const { payload } = await callTool(
      server,
      "plow_run_command",
      { argv: ["/bin/sh", "-c", `echo ${marker}; sleep 0.6; echo ${marker}-done`], wait_ms: 100 },
      auth,
    );
    expect(payload.status).toBe("running");
    return payload.handle as string;
  }

  it("one agent cannot read another's job output — even sharing a name", async () => {
    const { server } = makeServer();
    const handle = await startJob(server, ALICE, "alice-secret");

    const stolen = await callTool(server, "plow_get_output", { handle }, MALLORY);
    expect(stolen.isError).toBe(true);
    expect(JSON.stringify(stolen.payload)).not.toContain("alice-secret");

    // Indistinguishable from a handle that never existed.
    const invented = await callTool(server, "plow_get_output", { handle: "NO-SUCH-HANDLE" }, MALLORY);
    expect(JSON.stringify(stolen.payload)).toBe(
      JSON.stringify(invented.payload).replace("NO-SUCH-HANDLE", handle),
    );

    // The owner still reads it — nothing was consumed or broken.
    const owner = await callTool(server, "plow_get_output", { handle }, ALICE);
    expect(owner.isError).toBe(false);
    expect(owner.payload.output).toContain("alice-secret");
  });

  it("one agent's read cannot advance another's cursor", async () => {
    const { server } = makeServer();
    const aliceHandle = await startJob(server, ALICE, "alice");
    const malloryHandle = await startJob(server, MALLORY, "mallory");
    expect(aliceHandle).not.toBe(malloryHandle);

    /** Poll a job to completion — sandbox-exec startup is not instant. */
    const drain = async (handle: string, auth: RelayAuth) => {
      let out = { status: "running", output: "" } as any;
      for (let i = 0; i < 80 && out.status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 25));
        out = (await callTool(server, "plow_get_output", { handle, since: 0 }, auth)).payload;
      }
      return out;
    };

    // Alice reads her stream to the end. Repeatedly, from byte 0.
    const aliceOut = await drain(aliceHandle, ALICE);
    expect(aliceOut.status).toBe("completed");
    expect(aliceOut.output).toContain("alice");
    expect(aliceOut.output).not.toContain("mallory");

    // Mallory's stream is untouched by any of that: still readable from 0, in
    // full. Nothing Alice did consumed or advanced it.
    const malloryOut = await drain(malloryHandle, MALLORY);
    expect(malloryOut.status).toBe("completed");
    expect(malloryOut.output).toContain("mallory");
    expect(malloryOut.output).toContain("mallory-done");
    expect(malloryOut.output).not.toContain("alice");

    // And re-reading Alice's from 0 still yields everything — the cursor is the
    // caller's `since`, not shared state one agent can move for another.
    const aliceAgain = await callTool(
      server,
      "plow_get_output",
      { handle: aliceHandle, since: 0 },
      ALICE,
    );
    expect(aliceAgain.payload.output).toBe(aliceOut.output);
  });

  it("a deferred handle is not shared by two agents with the same name", async () => {
    const { server } = makeServer(new ScriptedPolicy("allow_once", 200), 40);
    const dir = tempDir();
    const file = path.join(dir, "alice.txt");
    fs.writeFileSync(file, "alice's file");
    const first = await callTool(server, "plow_read_file", { path: file }, ALICE);
    expect(first.payload.status).toBe("pending");

    const stolen = await callTool(
      server,
      "plow_get_result",
      { handle: first.payload.handle },
      MALLORY,
    );
    expect(stolen.payload).toEqual({ status: "unknown", handle: first.payload.handle });
  });

  it("an always-allow rule from one agent does not approve another's identical request", async () => {
    // Rule keys are (agent, device, capabilities). Two agents sharing a NAME
    // must not share a rule.
    const asked: string[] = [];
    const { server } = makeServer({
      async decideIntent(intent) {
        asked.push(intent.agentId);
        return { decision: "always_allow" as const, source: "ask" };
      },
    });
    const dir = tempDir();
    const file = path.join(dir, "shared.txt");
    fs.writeFileSync(file, "contents");

    await callTool(server, "plow_read_file", { path: file }, ALICE);
    expect(asked).toEqual(["sess_alice"]);

    // Alice's second identical call is served by her stored rule — not asked.
    await callTool(server, "plow_read_file", { path: file }, ALICE);
    expect(asked).toEqual(["sess_alice"]);

    // Mallory's identical call, same name, must still be asked.
    await callTool(server, "plow_read_file", { path: file }, MALLORY);
    expect(asked).toEqual(["sess_alice", "sess_mallory"]);
  });

  it("the audit trail names the agent and keys on the id", async () => {
    const { server, device } = makeServer();
    const dir = tempDir();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "x");
    await callTool(server, "plow_read_file", { path: file }, ALICE);
    await callTool(server, "plow_read_file", { path: file }, MALLORY);

    const received = device.audit
      .entries()
      .filter((e) => jv(e as JSONValue).get("event").str === "intent_received")
      .map((e) => ({
        agent: jv(e as JSONValue).get("agent").str,
        name: jv(e as JSONValue).get("agent_name").str,
      }));
    expect(received).toEqual([
      { agent: "sess_alice", name: "Claude Code" },
      { agent: "sess_mallory", name: "Claude Code" },
    ]);
    // The name alone could not tell these two apart; the id does.
    expect(new Set(received.map((r) => r.name)).size).toBe(1);
    expect(new Set(received.map((r) => r.agent)).size).toBe(2);
  });

});
