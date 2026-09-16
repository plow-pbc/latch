/**
 * The msgvault subsystem against the fake CLI (no real binary, no chat.db):
 * runtime resolution, argv/env shape, error surfaces, and the DeviceAgent
 * intent path with the audit log as the oracle.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Capability, Intent, JSONValue, jv, makeIntent } from "@domo/protocol";
import {
  DeviceAgent,
  HeadlessPolicy,
  MsgvaultClient,
  MsgvaultError,
  ResolvedMsgvaultRuntime,
  resolveMsgvaultRuntime,
} from "@domo/device-core";

const fixtures = fileURLToPath(new URL("../../../e2e/fixtures", import.meta.url));
const FAKE = path.join(fixtures, "fakeMsgvault.cjs");

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  delete process.env.DOMO_MSGVAULT_CMD;
  delete process.env.FAKE_MSGVAULT_DELAY_MS;
  delete process.env.FAKE_MSGVAULT_FAIL;
  delete process.env.FAKE_MSGVAULT_NO_STATS_JSON;
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-mv-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface LoggedCall {
  argv: string[];
  msgvaultHome: string | null;
}

function makeClient(msgvaultHome: string, logPath: string): MsgvaultClient {
  process.env.FAKE_MSGVAULT_LOG = logPath;
  cleanups.push(() => {
    delete process.env.FAKE_MSGVAULT_LOG;
  });
  return new MsgvaultClient({ command: ["node", FAKE], msgvaultHome });
}

function calls(logPath: string): LoggedCall[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LoggedCall);
}

describe("resolveMsgvaultRuntime", () => {
  it("honors the DOMO_MSGVAULT_CMD test seam", () => {
    process.env.DOMO_MSGVAULT_CMD = JSON.stringify(["node", FAKE]);
    const runtime = resolveMsgvaultRuntime();
    expect(runtime).toEqual({ command: ["node", FAKE], source: "custom", binaryPath: null });
  });

  it("rejects a non-JSON DOMO_MSGVAULT_CMD loudly", () => {
    process.env.DOMO_MSGVAULT_CMD = "not json";
    expect(() => resolveMsgvaultRuntime()).toThrow(/JSON argv/);
  });

  it("finds the bundled binary in a packaged resources dir — never a system install", () => {
    const resources = tempDir();
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    const binDir = path.join(resources, "msgvault", arch);
    fs.mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, "msgvault");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    fs.chmodSync(bin, 0o755);
    // Deterministic: a Homebrew msgvault on this machine must NOT win — its
    // version is untested by us, so resolution never looks at PATH.
    const runtime = resolveMsgvaultRuntime(resources);
    expect(runtime).toEqual({ command: [bin], source: "bundled", binaryPath: bin });
  });
});

describe("MsgvaultClient", () => {
  it("search passes agent text after -- so it can never become a flag", async () => {
    const dir = tempDir();
    const log = path.join(dir, "calls.ndjson");
    const client = makeClient(path.join(dir, "mvhome"), log);
    await client.search({ query: "--limit 999", limit: 2 });
    const [call] = calls(log);
    const sep = call.argv.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(call.argv.slice(0, sep)).toEqual(["search", "--json", "--limit", "2"]);
    expect(call.argv.slice(sep + 1)).toEqual(["--limit 999"]);
  });

  it("clamps limit and offset", async () => {
    const dir = tempDir();
    const log = path.join(dir, "calls.ndjson");
    const client = makeClient(path.join(dir, "mvhome"), log);
    await client.search({ query: "q", limit: 5000, offset: -3 });
    const [call] = calls(log);
    expect(call.argv).toContain("100");
    expect(call.argv).not.toContain("--offset");
  });

  it("always pins MSGVAULT_HOME to the home we own", async () => {
    const dir = tempDir();
    const log = path.join(dir, "calls.ndjson");
    await makeClient(path.join(dir, "mvhome"), log).stats();
    expect(calls(log)[0].msgvaultHome).toBe(path.join(dir, "mvhome"));
  });

  it("falls back to text stats when --json is rejected", async () => {
    const dir = tempDir();
    process.env.FAKE_MSGVAULT_NO_STATS_JSON = "1";
    const client = makeClient(path.join(dir, "mvhome"), path.join(dir, "l.ndjson"));
    const stats = await client.stats();
    expect(jv(stats).get("text").str).toContain("Messages: 100");
  });

  it("surfaces stderr on failure and times out as a timeout", async () => {
    const dir = tempDir();
    const client = makeClient(path.join(dir, "mvhome"), path.join(dir, "l.ndjson"));

    process.env.FAKE_MSGVAULT_FAIL = "archive is locked";
    await expect(client.search({ query: "q" })).rejects.toThrow(/archive is locked/);
    delete process.env.FAKE_MSGVAULT_FAIL;

    process.env.FAKE_MSGVAULT_DELAY_MS = "5000";
    const slow = new MsgvaultClient({
      command: ["node", FAKE],
      msgvaultHome: path.join(dir, "mvhome"),
      timeoutMs: 200,
    });
    await expect(slow.search({ query: "q" })).rejects.toSatisfy(
      (e: unknown) => e instanceof MsgvaultError && e.kind === "timeout",
    );
  });

  it("import passes the limit through", async () => {
    const dir = tempDir();
    const log = path.join(dir, "calls.ndjson");
    const client = makeClient(path.join(dir, "mvhome"), log);
    const { output } = await client.importIMessage(100);
    expect(output).toContain("Imported 100 messages");
    expect(calls(log)[0].argv).toEqual(["import-imessage", "--limit", "100"]);
  });
});

describe("DeviceAgent msgvault intents", () => {
  function makeAgent(
    delegate = new HeadlessPolicy({ intent: "allow_once" }),
    runtime?: ResolvedMsgvaultRuntime | null,
  ): { device: DeviceAgent; log: string } {
    const dir = tempDir();
    const log = path.join(dir, "calls.ndjson");
    process.env.FAKE_MSGVAULT_LOG = log;
    cleanups.push(() => {
      delete process.env.FAKE_MSGVAULT_LOG;
    });
    const resolved =
      runtime === undefined
        ? { command: ["node", FAKE], source: "bundled" as const, binaryPath: FAKE }
        : runtime;
    const device = new DeviceAgent(
      path.join(dir, "home"),
      "Test Mac",
      delegate,
      undefined,
      resolved,
    );
    cleanups.push(() => void device.shutdown());
    return { device, log };
  }

  const CAPS: Capability[] = [{ kind: "msgvault", access: "read" }];

  function intentFor(device: DeviceAgent, request: string): Intent {
    return makeIntent({
      agentId: "agent-1",
      agentDisplay: "Agent",
      deviceId: device.identity.deviceId,
      request,
      capabilities: CAPS,
      sessionId: "s1",
    });
  }

  const events = (device: DeviceAgent): string[] =>
    device.audit.entries().map((e) => jv(e as JSONValue).get("event").str ?? "");

  it("allowed search executes and audits msgvault_query", async () => {
    const { device } = makeAgent();
    const response = await device.handleIntent(intentFor(device, "search messages: flight"), {
      op: "search",
      query: "flight",
      limit: 2,
    });
    expect(jv(response).get("status").str).toBe("completed");
    expect(jv(response).get("result").arr?.length).toBe(2);
    expect(events(device)).toEqual(["intent_received", "intent_decision", "msgvault_query"]);
  });

  it("denied by kind: no query runs, nothing audited past the decision", async () => {
    const { device, log } = makeAgent(
      new HeadlessPolicy({ intent: "allow_once", denyKinds: ["msgvault"] }),
    );
    const response = await device.handleIntent(intentFor(device, "search"), {
      op: "search",
      query: "q",
    });
    expect(jv(response).get("status").str).toBe("denied");
    expect(events(device)).toEqual(["intent_received", "intent_decision"]);
    expect(calls(log)).toHaveLength(0);
  });

  it("an unknown op is refused without touching the binary", async () => {
    const { device, log } = makeAgent();
    const response = await device.handleIntent(intentFor(device, "x"), { op: "import" });
    expect(jv(response).get("status").str).toBe("error");
    expect(jv(response).get("error").str).toContain("unknown msgvault op");
    expect(calls(log)).toHaveLength(0);
  });

  it("no runtime: tools get a clean not-available error", async () => {
    const { device } = makeAgent(new HeadlessPolicy({ intent: "allow_once" }), null);
    const response = await device.handleIntent(intentFor(device, "search"), {
      op: "search",
      query: "q",
    });
    expect(jv(response).get("status").str).toBe("error");
    expect(jv(response).get("error").str).toContain("not available");
  });

  it("a failing binary audits msgvault_error", async () => {
    const { device } = makeAgent();
    process.env.FAKE_MSGVAULT_FAIL = "boom";
    const response = await device.handleIntent(intentFor(device, "search"), {
      op: "search",
      query: "q",
    });
    expect(jv(response).get("status").str).toBe("error");
    expect(events(device)).toContain("msgvault_error");
  });

  it("shutdown stops the daemon", async () => {
    const { device, log } = makeAgent();
    await device.shutdown();
    expect(calls(log).some((c) => c.argv[0] === "daemon" && c.argv[1] === "stop")).toBe(true);
  });

  it("registers the msgvault skill when a runtime is present", () => {
    const { device } = makeAgent();
    expect(device.skills.skill("msgvault-messages")).not.toBeNull();
  });
});
