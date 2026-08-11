/**
 * Blessed tools — twin of DomoDeviceCore/BlessedTools.swift. Trusted
 * in-process functionality exposed to agents with name + description + JSON
 * schema, discovered via list_device_tools.
 */
import os from "node:os";
import { JSONValue } from "@domo/protocol";
import { recall, DEFAULT_LIMIT } from "./recall.js";

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

  /** Manifest of the tools this device offers. */
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
    registry.register({
      name: "recall",
      description:
        "Recall durable facts about the people this Mac's owner communicates with — " +
        "work, relationships, preferences, commitments — drawn from their message " +
        "archive. Each fact carries the dates it was observed and the ids of the " +
        "messages it rests on. Returns facts only, never message text. Call this " +
        "when the task depends on something about a person that the conversation " +
        "does not already state.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you want to know, as a question." },
          limit: {
            type: "number",
            description: `Maximum facts to return (default ${DEFAULT_LIMIT}).`,
          },
        },
        required: ["query"],
      },
      invoke: async (args) => {
        const supplied = args as { query?: unknown; limit?: unknown };
        if (typeof supplied.query !== "string" || supplied.query.trim().length === 0) {
          throw new Error("recall requires a non-empty `query`");
        }
        // `limit` is handed straight through: recall() is the seam both this
        // tool and the future ambient caller share, so validating it there keeps
        // one rule instead of two that can drift. A non-number fails loudly
        // there rather than being silently swapped for the default here.
        const limit = supplied.limit as number | undefined;
        // Wrapped in an object rather than returned bare: a JSON array is a valid
        // JSONValue but leaves no room to say anything alongside it later.
        return { facts: await recall(supplied.query, limit) };
      },
    });
    return registry;
  }
}
