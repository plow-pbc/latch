/**
 * The Start-agent launch plan is what wires a spawned agent to Claude Code, so
 * its config shape, connection string, briefing, and launcher script are pinned
 * here (pure — no Electron/filesystem).
 */
import { describe, expect, it } from "vitest";
import { parseConnection } from "@domo/protocol";
import { briefing, planAgentLaunch, shQuote } from "../src/spawnAgent.js";

function plan(overrides: Partial<Parameters<typeof planAgentLaunch>[0]> = {}) {
  return planAgentLaunch({
    goal: "Check my disk space",
    deviceId: "device-abc",
    agentToken: "TOK-123",
    agentSocket: "wss://127.0.0.1:8443/",
    brokerPin: "PIN=",
    shimPath: "/repo/apps/mcp/dist/main.js",
    claudePath: "/opt/homebrew/bin/claude",
    runDir: "/home/run",
    stamp: "agent-xyz",
    ...overrides,
  });
}

describe("planAgentLaunch", () => {
  it("embeds a valid agent connection string (url + pin + token)", () => {
    const p = plan();
    const parsed = parseConnection(p.connectionString);
    expect(parsed).toEqual({
      url: "wss://127.0.0.1:8443/",
      pin: "PIN=",
      token: "TOK-123",
      name: "Goal agent",
      authenticate: false,
    });
  });

  it("builds an MCP config that runs the shim via node with DOMO_CONNECTION", () => {
    const p = plan() as { config: any };
    const domo = p.config.mcpServers.domo;
    expect(domo.command).toBe("node");
    expect(domo.args).toEqual(["/repo/apps/mcp/dist/main.js"]);
    expect(domo.env.DOMO_CONNECTION).toBe((plan() as any).connectionString);
  });

  it("names the per-session temp files by stamp under runDir", () => {
    const p = plan();
    expect(p.cfgPath).toBe("/home/run/agent-agent-xyz.mcp.json");
    expect(p.promptPath).toBe("/home/run/agent-agent-xyz.prompt.txt");
    expect(p.cmdPath).toBe("/home/run/agent-agent-xyz.command");
  });

  it("launcher passes the prompt FIRST, cleans up on exit, cds to $HOME", () => {
    const s = plan().script;
    expect(s.startsWith("#!/bin/bash\n")).toBe(true);
    expect(s).toContain("trap 'rm -f \"$CFG\" \"$PROMPTFILE\" \"$SELF\"' EXIT");
    expect(s).toContain('cd "$HOME"');
    // claude "$PROMPT" ... — prompt is the first positional arg.
    expect(s).toMatch(/claude' "\$PROMPT" --strict-mcp-config --mcp-config "\$CFG" --allowedTools mcp__domo/);
  });

  it("shell-quotes paths safely (no injection via odd chars)", () => {
    const p = plan({ claudePath: "/weird/pa'th/claude" });
    expect(p.script).toContain("'/weird/pa'\\''th/claude'");
    expect(shQuote("a'b")).toBe("'a'\\''b'");
  });

  it("briefing tells the agent access is already granted for the device", () => {
    const b = briefing("do X", "device-abc");
    expect(b).toContain('device id "device-abc"');
    expect(b).toContain("Do NOT call request_device_access");
    expect(b).toContain("do X");
  });
});
