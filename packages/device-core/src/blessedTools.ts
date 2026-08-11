/**
 * Blessed tools — twin of DomoDeviceCore/BlessedTools.swift. Trusted
 * in-process functionality exposed to agents with name + description + JSON
 * schema, discovered via list_device_tools.
 */
import os from "node:os";
import { JSONValue } from "@domo/protocol";
import { recall, DEFAULT_LIMIT, MAX_LIMIT } from "./recall.js";

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
          // The bounds are the ones recall() enforces. use_tool does not check
          // arguments against this schema, so it is documentation -- and an
          // agent that follows it and still gets rejected has been misled.
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_LIMIT,
            description: `Maximum facts to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
          },
        },
        required: ["query"],
      },
      invoke: async (args) => {
        // Only the narrowing from `unknown` happens here. Every actual rule --
        // non-empty query, integer limit in range -- lives in recall(), the seam
        // this tool and the future ambient caller share, so neither caller can
        // end up with a rule the other lacks.
        const supplied = args as { query?: unknown; limit?: unknown };
        if (typeof supplied.query !== "string") {
          throw new Error("recall requires a `query` string");
        }
        const limit = supplied.limit as number | undefined;
        // Wrapped in an object rather than returned bare: a JSON array is a valid
        // JSONValue but leaves no room to say anything alongside it later.
        return { facts: await recall(supplied.query, limit) };
      },
    });
    return registry;
  }
}
