/**
 * The msgvault tool surface, end to end and in process — the MCP server
 * driving the fake msgvault CLI (no real binary, no chat.db). The audit log is
 * the oracle; the shared read capability is proven by one always-allow rule
 * covering every msgvault tool.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSONValue, jv } from "@domo/protocol";
import {
  DeviceAgent,
  HeadlessPolicy,
  PolicyDelegate,
  ResolvedMsgvaultRuntime,
} from "@domo/device-core";
import { createDomoMcpServer, DomoMcpServer, RelayAuth } from "@domo/mcp-server";
import { callTool, parse, rpc } from "./client.js";

const fixtures = fileURLToPath(new URL("../../../e2e/fixtures", import.meta.url));
const FAKE = path.join(fixtures, "fakeMsgvault.cjs");

const AGENT: RelayAuth = { agent_id: "agent-1", agent_name: "Memo Agent", scopes: ["relay:call"] };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  delete process.env.FAKE_MSGVAULT_LOG;
  delete process.env.FAKE_MSGVAULT_DELAY_MS;
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-mvt-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeServer(
  delegate: PolicyDelegate = new HeadlessPolicy({ intent: "allow_once" }),
  opts: { runtime?: ResolvedMsgvaultRuntime | null; budgetMs?: number } = {},
): { server: DomoMcpServer; device: DeviceAgent } {
  const dir = tempDir();
  process.env.FAKE_MSGVAULT_LOG = path.join(dir, "calls.ndjson");
  const runtime =
    opts.runtime === undefined
      ? { command: ["node", FAKE], source: "bundled" as const, binaryPath: FAKE }
      : opts.runtime;
  const device = new DeviceAgent(
    path.join(dir, "home"),
    "Test Mac",
    delegate,
    undefined,
    runtime,
  );
  const server = createDomoMcpServer(
    device,
    opts.budgetMs === undefined ? {} : { budgetMs: opts.budgetMs },
  );
  cleanups.push(() => server.close());
  cleanups.push(() => device.shutdown());
  return { server, device };
}

const events = (device: DeviceAgent): string[] =>
  device.audit.entries().map((e) => jv(e as JSONValue).get("event").str ?? "");

describe("msgvault tools (fake CLI)", () => {
  it("advertises the msgvault skill via list_tools + read_skill", async () => {
    const { server } = makeServer();
    const list = parse(await rpc(server, "tools/call", { name: "plow_list_skills", arguments: {} }, AGENT));
    const skills = JSON.parse(list.result!.content![0].text).skills as { name: string }[];
    expect(skills.map((s) => s.name)).toContain("msgvault-messages");
    const { payload } = await callTool(server, "plow_read_skill", { name: "msgvault-messages" }, AGENT);
    expect(payload.body).toContain("plow_msgvault_search");
  });

  it("search executes end to end and audits", async () => {
    const { server, device } = makeServer();
    const { payload, isError } = await callTool(
      server,
      "plow_msgvault_search",
      { query: "flight", limit: 2, goal: "find the flight number" },
      AGENT,
    );
    expect(isError, JSON.stringify(payload)).toBe(false);
    expect(Array.isArray(payload)).toBe(true);
    expect((payload as unknown as JSONValue[]).length).toBe(2);
    expect(events(device)).toEqual(["intent_received", "intent_decision", "msgvault_query"]);
  });

  it("one always-allow rule covers every msgvault tool", async () => {
    const { server, device } = makeServer(new HeadlessPolicy({ intent: "always_allow" }));
    await callTool(server, "plow_msgvault_search", { query: "q" }, AGENT);
    // A DIFFERENT msgvault tool must hit the rule stored by the first call —
    // the capability shape is shared, so the rule key matches.
    await callTool(server, "plow_msgvault_get_message", { id: "m1" }, AGENT);
    await callTool(server, "plow_msgvault_stats", {}, AGENT);
    const decisions = device.audit
      .entries()
      .filter((e) => jv(e as JSONValue).get("event").str === "intent_decision")
      .map((e) => jv(e as JSONValue).get("source").str);
    expect(decisions).toEqual(["prompt", "rule", "rule"]);
  });

  it("get_message returns the full message", async () => {
    const { server } = makeServer();
    const { payload, isError } = await callTool(server, "plow_msgvault_get_message", { id: "m1" }, AGENT);
    expect(isError).toBe(false);
    expect(payload.id).toBe("m1");
    expect(payload.body).toBe("full text");
  });

  it("a slow first call defers and get_result completes it", async () => {
    process.env.FAKE_MSGVAULT_DELAY_MS = "300";
    const { server } = makeServer(new HeadlessPolicy({ intent: "allow_once" }), { budgetMs: 30 });
    const { payload, isError } = await callTool(server, "plow_msgvault_search", { query: "q" }, AGENT);
    expect(isError).toBe(false);
    expect(payload.status).toBe("pending");
    const handle: string = payload.handle;
    let poll = payload;
    for (let i = 0; i < 80 && poll.status === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      poll = (await callTool(server, "plow_get_result", { handle }, AGENT)).payload;
    }
    expect(poll.status).toBe("ready");
    expect(Array.isArray(poll.result)).toBe(true);
  });

  it("a denial surfaces as denied", async () => {
    const { server } = makeServer(
      new HeadlessPolicy({ intent: "allow_once", denyKinds: ["msgvault"] }),
    );
    const { payload, isError } = await callTool(server, "plow_msgvault_search", { query: "q" }, AGENT);
    expect(isError).toBe(true);
    expect(JSON.stringify(payload)).toContain("denied");
  });

  it("no runtime installed: a clean not-available error", async () => {
    const { server } = makeServer(new HeadlessPolicy({ intent: "allow_once" }), { runtime: null });
    const { payload, isError } = await callTool(server, "plow_msgvault_search", { query: "q" }, AGENT);
    expect(isError).toBe(true);
    expect(JSON.stringify(payload)).toContain("not available");
  });

  it("a missing query is the agent's error, no intent raised", async () => {
    const { server, device } = makeServer();
    const { isError } = await callTool(server, "plow_msgvault_search", {}, AGENT);
    expect(isError).toBe(true);
    expect(events(device)).toEqual([]);
  });
});
