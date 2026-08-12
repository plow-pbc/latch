/**
 * Blessed tools — twin of DomoDeviceCore/BlessedTools.swift. Trusted
 * in-process functionality exposed to agents with name + description + JSON
 * schema, discovered via list_device_tools.
 */
import os from "node:os";
import { JSONValue } from "@domo/protocol";
import { recall } from "./ltmm.js";

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
      // The scope and the empty-result sentence are load-bearing: seeding builds
      // from one conversation, so promising facts about everyone the owner talks
      // to made `[]` read as "no such fact" rather than "not in this store".
      description:
        "Recall durable facts about the person this Mac's owner messages most, and the " +
        "people who come up in that conversation — work, relationships, preferences, " +
        "commitments — drawn from its history. Each fact carries the dates it was " +
        "observed and the ids of the messages it rests on. Returns facts only, never " +
        "message text. Call this when the task depends on something about that person " +
        "the conversation does not already state. An empty result means this store " +
        "holds nothing on the subject — it is not evidence that no such fact exists, " +
        "and says nothing about anyone outside that conversation.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you want to know, as a question." },
        },
        required: ["query"],
      },
      invoke: async (args) => {
        // Only the narrowing from `unknown` happens here. The one actual rule --
        // a non-empty query -- lives in recall(), the seam this tool and the
        // future ambient caller share, so neither can end up with a rule the
        // other lacks. How many facts come back is not the caller's to choose.
        const supplied = args as { query?: unknown };
        if (typeof supplied.query !== "string") {
          throw new Error("recall requires a `query` string");
        }
        // Wrapped in an object rather than returned bare: a JSON array is a valid
        // JSONValue but leaves no room to say anything alongside it later.
        return { facts: await recall(supplied.query) };
      },
    });
    return registry;
  }
}
