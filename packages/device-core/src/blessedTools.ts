/**
 * Blessed tools — twin of DomoDeviceCore/BlessedTools.swift. Trusted
 * in-process functionality exposed to agents with name + description + JSON
 * schema, discovered via list_device_tools.
 */
import os from "node:os";
import { JSONValue } from "@domo/protocol";

export interface BlessedTool {
  name: string;
  description: string;
  inputSchema: JSONValue;
  invoke(args: JSONValue): Promise<JSONValue>;
}

export class BlessedToolRegistry {
  private tools = new Map<string, BlessedTool>();

  register(tool: BlessedTool): void {
    this.tools.set(tool.name, tool);
  }

  tool(name: string): BlessedTool | null {
    return this.tools.get(name) ?? null;
  }

  /** Manifest sent to the broker at registration. */
  manifest(): JSONValue {
    return [...this.tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
  }

  /** The built-in demo tool set. */
  static standard(): BlessedToolRegistry {
    const registry = new BlessedToolRegistry();
    registry.register({
      name: "mac_info",
      description:
        "Basic information about this Mac: hostname, OS version, current user, uptime.",
      inputSchema: { type: "object", properties: {} },
      invoke: async () => ({
        hostname: os.hostname(),
        os_version: os.version(),
        user: os.userInfo().username,
        uptime_seconds: Math.round(os.uptime()),
      }),
    });
    return registry;
  }
}
