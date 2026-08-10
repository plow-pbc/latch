/**
 * Pure planning for the Mac-initiated "Start agent" flow (DESIGN.md §2) — no
 * Electron, no filesystem — so the launcher script, MCP config, and briefing
 * are unit-testable. main.ts calls requestSpawnAgent, hands the result here,
 * then performs the side effects (write files, open Terminal) from the plan.
 */
import { compactString, DomoConnection } from "@domo/protocol";

export interface AgentLaunchPlan {
  /** Ephemeral MCP config (written to cfgPath, referenced by the launcher). */
  config: unknown;
  /** The agent connection string embedded in the config (url + pin + token). */
  connectionString: string;
  /** Absolute paths for the per-session temp files. */
  cfgPath: string;
  promptPath: string;
  cmdPath: string;
  /** The prompt the agent is seeded with. */
  prompt: string;
  /** The bash launcher script Terminal executes. */
  script: string;
  /** A ready one-liner to run the same agent elsewhere. */
  oneLiner: string;
}

export function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** The prompt the Terminal agent is seeded with (verbatim from the Swift app). */
export function briefing(goal: string, deviceId: string): string {
  return (
    `You are a Domo remote agent running in a terminal. The "domo" MCP tools are ` +
    `your ONLY way to act on the Mac — do not use local shell, file, or other ` +
    `built-in tools. They run on the target Mac with the owner's approval and ` +
    `sandboxing.\n\n` +
    `You already have access to the Mac with device id "${deviceId}". Do NOT call ` +
    `request_device_access — access is already granted. (You may call list_devices ` +
    `to confirm it is online, or list_device_tools to see extra capabilities, but ` +
    `that is optional.)\n\n` +
    `Do this now, without waiting for further input: carry out the goal below using ` +
    `the domo tools with device "${deviceId}" — run_command (pass the device id and ` +
    `declare read_paths / write_paths for every path you touch), read_file, ` +
    `write_file, or use_tool. The owner approves each operation on the Mac. When ` +
    `done, briefly report what you did.\n\n` +
    `Goal:\n${goal}`
  );
}

export function planAgentLaunch(args: {
  goal: string;
  deviceId: string;
  agentToken: string;
  /** The broker's agent endpoint (from the spawn response `socket`). */
  agentSocket: string;
  /** The broker cert pin, if any (so a wss broker works). */
  brokerPin?: string;
  /** Path to the domo-mcp shim JS. */
  shimPath: string;
  /**
   * Node-capable binary that runs the shim. The app passes its own
   * process.execPath (Electron IS Node) so the flow works on Macs with no
   * system node — e.g. Claude Code's native install, which bundles its runtime.
   */
  nodePath: string;
  /** Absolute path to Claude Code CLI (from the launcher's environment). */
  claudePath: string;
  /** Directory for the per-session temp files (home/run). */
  runDir: string;
  /** Stable stamp for the temp file names (e.g. the spawned agent id). */
  stamp: string;
}): AgentLaunchPlan {
  const agentConn: DomoConnection = {
    url: args.agentSocket,
    pin: args.brokerPin,
    token: args.agentToken,
    name: "Goal agent",
    authenticate: false,
  };
  const connectionString = compactString(agentConn);
  const config = {
    mcpServers: {
      domo: {
        type: "stdio",
        command: args.nodePath,
        args: [args.shimPath],
        // ELECTRON_RUN_AS_NODE makes an Electron binary act as plain node;
        // a real node binary ignores it.
        env: { DOMO_CONNECTION: connectionString, ELECTRON_RUN_AS_NODE: "1" },
      },
    },
  };
  const cfgPath = `${args.runDir}/agent-${args.stamp}.mcp.json`;
  const promptPath = `${args.runDir}/agent-${args.stamp}.prompt.txt`;
  const cmdPath = `${args.runDir}/agent-${args.stamp}.command`;
  const prompt = briefing(args.goal, args.deviceId);

  // Goal passed via file (no shell quoting), pre-filled in the prompt —
  // interactive claude can't auto-submit, so the user presses Return. The
  // prompt MUST come first (--mcp-config/--allowedTools are variadic). cd $HOME
  // so any folder-trust prompt is against an already-trusted dir. The launcher
  // removes all three temp files on exit (the config carries the token).
  const script =
    `#!/bin/bash\n` +
    `CFG=${shQuote(cfgPath)}\n` +
    `PROMPTFILE=${shQuote(promptPath)}\n` +
    `SELF=${shQuote(cmdPath)}\n` +
    `trap 'rm -f "$CFG" "$PROMPTFILE" "$SELF"' EXIT\n` +
    `PROMPT="$(cat "$PROMPTFILE")"\n` +
    `cd "$HOME"\n` +
    `${shQuote(args.claudePath)} "$PROMPT" --strict-mcp-config --mcp-config "$CFG" --allowedTools mcp__domo\n`;

  const oneLiner = `claude --strict-mcp-config --mcp-config '${JSON.stringify(config)}' --allowedTools mcp__domo`;

  return { config, connectionString, cfgPath, promptPath, cmdPath, prompt, script, oneLiner };
}
