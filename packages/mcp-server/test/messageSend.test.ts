/** Exercise the actual MCP, policy, SQLite, and audit paths without addressing
 * a messaging app. Only the irreversible app-send boundary is replaced. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize, jv, type JSONValue } from "@domo/protocol";
import {
  auditActivities,
  DeviceAgent,
  FileOpsError,
  HeadlessPolicy,
  parseManifest,
  type StagedPlugin,
  scriptedProbes,
  type ExecResult,
  type PolicyDelegate,
} from "@domo/device-core";
import * as messageSend from "../../device-core/src/messageSend.js";
import { createDomoMcpServer, type DomoMcpServer, type RelayAuth } from "@domo/mcp-server";
import { callTool, pollUntil } from "./client.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

const AGENT: RelayAuth = { agent_id: "send-agent", agent_name: "Send Test", scopes: ["relay:call"] };
const SEND = { app: "imessage", recipient: "Ada@Example.com", body: "hello" };
const FINISHED: ExecResult = {
  handle: "internal-script", running: false, exitCode: 0,
  output: Buffer.alloc(0), outputLength: 0, stderr: Buffer.alloc(0), reaped: false,
};

function fixture(delegate: PolicyDelegate = new HeadlessPolicy({ intent: "allow_once" }), withDecoder = false): {
  server: DomoMcpServer; device: DeviceAgent; db: string; insert: (body?: string, attributed?: boolean) => void;
} {
  const home = canonicalize(fs.mkdtempSync(path.join(os.tmpdir(), "domo-mcp-send-")));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const db = messageSend.storePathFor("imessage", home);
  fs.mkdirSync(path.dirname(db), { recursive: true });
  execFileSync("/usr/bin/sqlite3", [db, [
    "create table handle (ROWID integer primary key, id text);",
    "create table chat (ROWID integer primary key, guid text, chat_identifier text, style integer);",
    "create table message (ROWID integer primary key, handle_id integer, date integer, is_from_me integer, is_sent integer, is_delivered integer, error integer, text text, attributedBody blob, guid text, item_type integer default 0, associated_message_type integer default 0, service text default 'iMessage');",
    "create table chat_message_join (chat_id integer, message_id integer);",
    "insert into handle values (1, 'ada@example.com');",
    "insert into chat values (1, 'iMessage;-;ada@example.com', 'ada@example.com', 45);",
  ].join(" ")]);
  const probes = scriptedProbes({
    inspect: { [db]: { isDirectory: false, readable: true, writable: true, flags: [] } },
    openAsApp: { [db]: "EPERM" },
    fullDiskAccess: false,
  });
  const plugins: StagedPlugin[] = withDecoder ? [{
    manifest: parseManifest(fs.readFileSync(new URL("../../../apps/desktop/plugins/messages/latch-plugin.json", import.meta.url), "utf8")),
    dir: home, binDir: path.join(home, "bin"),
  }] : [];
  const device = new DeviceAgent(home, "Test Mac", delegate, null, home, null, plugins, null, probes);
  const server = createDomoMcpServer(device, { budgetMs: 20 });
  cleanups.push(() => server.close());
  let next = 0;
  return { server, device, db, insert: (body = "hello", attributed = false) => {
    next += 1;
    execFileSync("/usr/bin/sqlite3", [db,
      `insert into message values (${next}, 1, ${next}, 1, 1, 0, 0, cast(X'${Buffer.from(body).toString("hex")}' as text), ${attributed ? "X'010203'" : "NULL"}, 'message-${next}', 0, 0, 'iMessage'); insert into chat_message_join values (1, ${next});`,
    ]);
  } };
}

/** The production observation window is five seconds, longer than one generic poll. */
async function resultOf(server: DomoMcpServer, first: Awaited<ReturnType<typeof callTool>>) {
  if (first.payload.status !== "pending") return first.payload;
  for (let i = 0; i < 6; i++) {
    const response = await pollUntil(
      () => callTool(server, "plow_get_result", { handle: first.payload.handle }, AGENT),
      (r) => r.payload.status !== "pending",
    );
    if (response.payload.status !== "pending") return response.payload.result;
  }
  throw new Error("message verification did not finish");
}

describe.skipIf(process.platform !== "darwin")("plow_send_message integration", () => {
  it("shows the canonical recipient and exact text before a denial and never runs a script", async () => {
    const decideIntent = vi.fn(async () => "deny" as const);
    const { server, device } = fixture({ decideIntent });
    const script = vi.spyOn(device.executor, "runAppleScript");
    const response = await callTool(server, "plow_send_message", SEND, AGENT);
    expect(response.payload.status).toBe("denied");
    expect(decideIntent.mock.calls[0]?.[0]).toMatchObject({ capabilities: [
      { kind: "message_send", app: "imessage", recipient: "ada@example.com", bodyPreview: "hello" },
    ] });
    expect(script).not.toHaveBeenCalled();
  });

  it("runs once, verifies the real SQLite row, and stores a rule only for this agent and recipient", async () => {
    const decideIntent = vi.fn<PolicyDelegate["decideIntent"]>(async () => "always_allow");
    const { server, device, insert } = fixture({ decideIntent });
    const script = vi.spyOn(device.executor, "runAppleScript").mockImplementation(async ({ args }) => {
      insert(args?.[0]);
      return FINISHED;
    });
    for (const body of ["hello", "a second body"]) {
      const first = await callTool(server, "plow_send_message", { ...SEND, body }, AGENT);
      const result = await resultOf(server, first);
      expect(result).toMatchObject({ status: "verified", recipient: "ada@example.com" });
    }
    expect(script).toHaveBeenCalledTimes(2);
    expect(decideIntent).toHaveBeenCalledTimes(1);
    expect(device.audit.entries().filter((e) => jv(e as JSONValue).get("event").str === "message_send_result")).toHaveLength(2);
    decideIntent.mockResolvedValue("deny");
    expect((await callTool(server, "plow_send_message", { ...SEND, recipient: "grace@example.com" }, AGENT)).payload.status).toBe("denied");
    expect((await callTool(server, "plow_send_message", SEND, { ...AGENT, agent_id: "other-agent" })).payload.status).toBe("denied");
    expect(script).toHaveBeenCalledTimes(2);
  });

  it("keeps the deferred result pending until a slow script exits, then verifies once", async () => {
    const { server, device, insert } = fixture();
    let finish: (() => void) | undefined;
    const script = vi.spyOn(device.executor, "runAppleScript").mockResolvedValue({ ...FINISHED, running: true, exitCode: null });
    vi.spyOn(device.executor, "onExit").mockImplementation((_handle, callback) => { finish = () => callback(0, false); });
    vi.spyOn(device.executor, "output").mockReturnValue(FINISHED);
    const first = await callTool(server, "plow_send_message", SEND, AGENT);
    expect(first.payload.status).toBe("pending");
    expect(first.payload.reason).toBe("running");
    expect(auditActivities(device.audit.entries() as JSONValue[])[0]?.status).toBe("Running");
    expect((await callTool(server, "plow_get_result", { handle: first.payload.handle }, AGENT)).payload.status).toBe("pending");
    expect((await callTool(server, "plow_get_result", { handle: first.payload.handle }, { ...AGENT, agent_id: "other-agent" })).payload.status).toBe("unknown");
    insert();
    expect(finish).toBeTypeOf("function");
    finish!();
    const done = await resultOf(server, first);
    expect(done).toMatchObject({ status: "verified", row: { rowid: 1 } });
    expect(script).toHaveBeenCalledTimes(1);
    expect(auditActivities(device.audit.entries() as JSONValue[])[0]?.status).toBe("Completed");
  });

  it("serializes simultaneous same-body sends before taking their snapshots", async () => {
    const { server, device, insert } = fixture();
    const script = vi.spyOn(device.executor, "runAppleScript").mockImplementation(async ({ args }) => {
      insert(args?.[0]);
      return FINISHED;
    });
    const first = await callTool(server, "plow_send_message", SEND, AGENT);
    const second = await callTool(server, "plow_send_message", SEND, AGENT);
    expect(script).toHaveBeenCalledTimes(1);
    expect(auditActivities(device.audit.entries() as JSONValue[])[0]?.status).toBe("Queued");
    expect(await resultOf(server, first)).toMatchObject({ status: "verified", row: { rowid: 1 } });
    expect(await resultOf(server, second)).toMatchObject({ status: "verified", row: { rowid: 2 } });
    expect(script).toHaveBeenCalledTimes(2);
  });

  it.each([
    { description: "exact identity", fields: {}, status: "verified" },
    { description: "wrong row", fields: { rowid: 2 }, status: "unverified" },
    { description: "wrong chat", fields: { chat_guid: "iMessage;-;another@example.com" }, status: "unverified" },
    { description: "inbound row", fields: { is_from_me: false }, status: "unverified" },
    { description: "failed decode", fields: { body: null }, status: "unverified" },
  ])("uses the sandboxed pinned decoder and checks $description", async ({ fields, status }) => {
    const body = "don't | split\r\n  🙂漢字";
    const { server, device, insert, db: liveDb } = fixture(new HeadlessPolicy({ intent: "allow_once" }), true);
    vi.spyOn(device.executor, "runAppleScript").mockImplementation(async () => {
      insert("stale text column", true);
      return FINISHED;
    });
    const decoder = vi.spyOn(device.executor, "run").mockResolvedValue(FINISHED);
    vi.spyOn(device.executor, "stdout").mockReturnValue(Buffer.from(JSON.stringify({
      rowid: 1, chat_guid: "iMessage;-;ada@example.com", is_from_me: true, body,
      ...fields,
    }) + "\n"));
    const first = await callTool(server, "plow_send_message", { ...SEND, body }, AGENT);
    expect(await resultOf(server, first)).toMatchObject({ status });
    expect(decoder).toHaveBeenCalledWith(expect.objectContaining({
      argv: expect.arrayContaining(["search", "--chat-id", "1", "--after-rowid", "0"]),
      writePaths: [], network: false, appleEvents: false,
    }));
    expect(decoder).toHaveBeenCalledOnce();
    const options = decoder.mock.calls[0]![0];
    const scratch = options.argv[options.argv.indexOf("--store") + 1]!;
    expect(scratch).not.toBe(liveDb);
    expect(options.readPaths).not.toContain(path.dirname(liveDb));
    expect(fs.existsSync(path.dirname(scratch))).toBe(false);
  });

  it("diagnoses a pre-send store refusal and records that no script was attempted", async () => {
    const { server, device, db } = fixture();
    vi.spyOn(messageSend, "sqliteText").mockRejectedValue(new FileOpsError("could not read the message store", false, {
      code: "EPERM", syscall: "open", path: db,
    }));
    const script = vi.spyOn(device.executor, "runAppleScript");
    const first = await callTool(server, "plow_send_message", SEND, AGENT);
    const response = first.payload.status === "pending"
      ? (await pollUntil(
        () => callTool(server, "plow_get_result", { handle: first.payload.handle }, AGENT),
        (r) => r.payload.status !== "pending",
      )).payload.result
      : first.payload;
    expect(response).toMatchObject({ status: "blocked", diagnosis: { permission: "full_disk_access" } });
    expect(script).not.toHaveBeenCalled();
    const events = device.audit.entries().map((e) => jv(e as JSONValue).get("event").str);
    expect(events).toContain("message_send_refused");
    expect(events).toContain("host_permission_blocked");
  });
});
