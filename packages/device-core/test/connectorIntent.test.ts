import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSONValue, jv, makeIntent } from "@domo/protocol";
import { ConnectorClient, ConnectorError, DeviceAgent, HeadlessPolicy } from "@domo/device-core";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "latch-connector-"));

/** A device whose connector is the given stub, always approving. */
function deviceWith(connectors: ConnectorClient | null): DeviceAgent {
  return new DeviceAgent(
    tempDir(),
    "Test Mac",
    new HeadlessPolicy({ intent: "allow_once" }),
    null,
    undefined,
    connectors,
  );
}

function run(
  device: DeviceAgent,
  tool: string,
  payload: JSONValue,
  target?: string,
): Promise<JSONValue> {
  const intent = makeIntent({
    agentId: "a1",
    agentDisplay: "Agent",
    deviceId: device.identity.deviceId,
    request: "use slack",
    capabilities: [{ kind: "tool", tool, target }],
    sessionId: "s1",
  });
  return device.handleIntent(intent, payload);
}

const events = (device: DeviceAgent): string[] =>
  device.audit.entries().map((e) => jv(e).get("event").str ?? "");

describe("tool capability execution", () => {
  it("routes a slack tool capability to the connector client", async () => {
    const calls: { action: string; body: unknown }[] = [];
    const device = deviceWith({
      call: async (action, body) => {
        calls.push({ action, body });
        return { ts: "1.2", channel: "C1" };
      },
    });

    const response = await run(
      device,
      "slack.messages.send",
      { account: "T1", channel_id: "C1", text: "hello" },
      "T1/C1",
    );

    expect(calls).toEqual([
      { action: "messages.send", body: { account: "T1", channel_id: "C1", text: "hello" } },
    ]);
    // NESTED, never spread: `status` here is this Mac's verdict and the
    // connector's body is data underneath it.
    expect(response).toEqual({ status: "completed", result: { ts: "1.2", channel: "C1" } });
  });

  it("routes a slack.status capability to the status action", async () => {
    const calls: string[] = [];
    const device = deviceWith({
      call: async (action) => {
        calls.push(action);
        return { connected: true, team: "T1" };
      },
    });

    const response = await run(device, "slack.status", {});

    expect(calls).toEqual(["status"]);
    expect(response).toEqual({ status: "completed", result: { connected: true, team: "T1" } });
  });

  // The whole point of the closed set, from the device's side: a capability
  // naming a route this Mac cannot perform never becomes a call, so the device
  // credential — `relay:device` + `llm:chat` — is never carried anywhere else.
  it.each([
    { what: "traversal", tool: "slack.../../../v1/relay/agents" },
    { what: "a query", tool: "slack.channels.list?x=1" },
    { what: "a fragment", tool: "slack.channels.list#x" },
    { what: "another connector entirely", tool: "notslack.channels.list" },
  ])("never calls the connector for a capability naming $what", async ({ tool }) => {
    const calls: string[] = [];
    const device = deviceWith({
      call: async (action) => {
        calls.push(action);
        return {};
      },
    });

    const response = await run(device, tool, { account: "T1" });

    expect(calls).toEqual([]);
    expect(response).toEqual({ status: "error", error: ConnectorError.unknownAction().message });
    // Refused, and recorded as refused — never as an invocation.
    expect(events(device)).toContain("tool_error");
    expect(events(device)).not.toContain("tool_invoked");
  });

  it("reports a clear error when no connector client is configured", async () => {
    const device = deviceWith(null);
    const response = await run(device, "slack.channels.list", { account: "T1" }, "T1");
    expect(JSON.stringify(response)).toContain("not paired");
    expect(events(device)).not.toContain("tool_invoked");
  });

  // The record must not deny a side effect that may have happened: a call that
  // reached Plow and failed on the way back is an invocation AND an error.
  it("records the invocation before the call, so a failure cannot un-send it", async () => {
    const device = deviceWith({
      call: async () => {
        throw ConnectorError.unreachable("messages.send");
      },
    });

    const response = await run(
      device,
      "slack.messages.send",
      { account: "T1", channel_id: "C1", text: "the launch codes" },
      "T1/C1",
    );

    expect(response).toMatchObject({ status: "error" });
    expect(events(device)).toEqual(
      expect.arrayContaining(["tool_invoked", "tool_error"]),
    );
  });

  it("audits the action and the target, never the message", async () => {
    const device = deviceWith({ call: async () => ({ ok: true }) });

    await run(
      device,
      "slack.messages.send",
      { account: "T1", channel_id: "C1", text: "the launch codes" },
      "T1/C1",
    );

    const log = JSON.stringify(device.audit.entries());
    expect(log).toContain("tool_invoked");
    expect(log).toContain("T1/C1");
    expect(log).not.toContain("the launch codes");
  });

  // A bug in here is not a connector failure, and must not be silently one:
  // it still leaves a record, and it still escapes.
  it("records and rethrows a failure that is not a connector failure", async () => {
    const device = deviceWith({
      call: async () => {
        throw new TypeError("connectors.call is not a function");
      },
    });

    await expect(
      run(device, "slack.channels.list", { account: "T1" }, "T1"),
    ).rejects.toThrow(TypeError);
    expect(events(device)).toEqual(
      expect.arrayContaining(["tool_invoked", "tool_error"]),
    );
    // Not even a bug's message: it is not text this Mac wrote.
    expect(JSON.stringify(device.audit.entries())).not.toContain("is not a function");
  });
});
