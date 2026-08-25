import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeIntent } from "@domo/protocol";
import { DeviceAgent, HeadlessPolicy } from "@domo/device-core";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "latch-connector-"));

describe("tool capability execution", () => {
  it("routes a slack tool capability to the connector client", async () => {
    const calls: { action: string; body: unknown }[] = [];
    const connectors = {
      call: async (action: string, body: unknown) => {
        calls.push({ action, body });
        return { ts: "1.2", channel: "C1" };
      },
      status: async () => ({ connected: true }),
    };
    const device = new DeviceAgent(
      tempDir(),
      "Test Mac",
      new HeadlessPolicy({ intent: "allow_once" }),
      null,
      undefined,
      connectors,
    );

    const intent = makeIntent({
      agentId: "a1",
      agentDisplay: "Agent",
      deviceId: device.identity.deviceId,
      request: "send a slack message",
      capabilities: [{ kind: "tool", tool: "slack.messages.send" }],
      sessionId: "s1",
    });

    const response = await device.handleIntent(intent, {
      account: "T1",
      channel_id: "C1",
      text: "hello",
    });

    expect(calls).toEqual([
      { action: "messages.send", body: { account: "T1", channel_id: "C1", text: "hello" } },
    ]);
    expect(response).toMatchObject({ ts: "1.2", channel: "C1" });
  });

  it("reports a clear error when no connector client is configured", async () => {
    const device = new DeviceAgent(
      tempDir(),
      "Test Mac",
      new HeadlessPolicy({ intent: "allow_once" }),
    );
    const intent = makeIntent({
      agentId: "a1",
      agentDisplay: "Agent",
      deviceId: device.identity.deviceId,
      request: "list slack channels",
      capabilities: [{ kind: "tool", tool: "slack.channels.list" }],
      sessionId: "s1",
    });
    const response = await device.handleIntent(intent, { account: "T1" });
    expect(JSON.stringify(response)).toContain("not paired");
  });
});
