import { describe, expect, it } from "vitest";
import { JSONValue } from "@domo/protocol";
import { Progress } from "../src/deferred.js";
import { ToolContext } from "../src/toolKit.js";
import { SLACK_READ_TOOLS } from "../src/slackTools.js";

/**
 * A `ToolContext` whose device's `handleIntent` is stubbed to capture the
 * capability set and payload the tool built, rather than a real `DeviceAgent`
 * — the shape used in mcpServer.test.ts, minus the parts these tools never
 * touch (`decideAndRun` only reads `ctx.device.identity.deviceId` and calls
 * `ctx.device.handleIntent`).
 */
function fakeCtx(
  handleIntent: (capabilities: unknown[], payload: unknown) => JSONValue,
): ToolContext {
  return {
    device: {
      identity: { deviceId: "device-1" },
      handleIntent: async (intent: { capabilities: unknown[] }, payload: unknown) =>
        handleIntent(intent.capabilities, payload),
    },
    agent: { agentId: "agent-1", agentName: "Agent One" },
    sessionId: "session-1",
  } as unknown as ToolContext;
}

function fakeProgress(): Progress {
  return { decided: () => {} };
}

describe("Slack read tools", () => {
  it("exposes exactly the five read tools, all flagged read-only", () => {
    expect(SLACK_READ_TOOLS.map((t) => t.name).sort()).toEqual([
      "plow_slack_channels",
      "plow_slack_messages",
      "plow_slack_search",
      "plow_slack_status",
      "plow_slack_users",
    ]);
    for (const t of SLACK_READ_TOOLS) {
      expect(t.annotations.readOnlyHint, t.name).toBe(true);
      expect(t.deferrable, t.name).toBe(true);
    }
  });

  it("builds one slack tool capability naming the action", async () => {
    const spec = SLACK_READ_TOOLS.find((t) => t.name === "plow_slack_messages")!;
    const seen: { capabilities: unknown[]; payload: unknown }[] = [];
    const ctx = fakeCtx((capabilities, payload) => {
      seen.push({ capabilities, payload });
      return { messages: [] };
    });

    await spec.run({ account: "T1", channel_id: "C1", limit: 5 }, ctx, fakeProgress());

    expect(seen[0].capabilities).toEqual([{ kind: "tool", tool: "slack.messages.list" }]);
    expect(seen[0].payload).toEqual({ account: "T1", channel_id: "C1", limit: 5 });
  });

  it("rejects a missing required argument before building an intent", async () => {
    const spec = SLACK_READ_TOOLS.find((t) => t.name === "plow_slack_messages")!;
    await expect(
      spec.run({ account: "T1" }, fakeCtx(() => ({})), fakeProgress()),
    ).rejects.toThrow(/channel_id/);
  });
});
