import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Capability, JSONValue, jv, RuleKey } from "@domo/protocol";
import { DeviceAgent, HeadlessPolicy } from "@domo/device-core";
import { DeniedError, Progress } from "../src/deferred.js";
import { ToolContext, ToolSpec } from "../src/toolKit.js";
import { SLACK_READ_TOOLS, SLACK_WRITE_TOOLS } from "../src/slackTools.js";

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

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** A REAL device, so the whole seam runs: tool → intent → device → connector. */
function realCtx(connectorBody: JSONValue): ToolContext {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "latch-slack-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const device = new DeviceAgent(
    home,
    "Test Mac",
    new HeadlessPolicy({ intent: "allow_once" }),
    null,
    undefined,
    { call: async () => connectorBody },
  );
  return {
    device,
    agent: { agentId: "agent-1", agentName: "Agent One" },
    sessionId: "session-1",
  } as unknown as ToolContext;
}

function fakeProgress(): Progress {
  return { decided: () => {} };
}

const messages = SLACK_READ_TOOLS.find((t) => t.name === "plow_slack_messages")!;
const search = SLACK_READ_TOOLS.find((t) => t.name === "plow_slack_search")!;
const send = SLACK_WRITE_TOOLS.find((t) => t.name === "plow_slack_send")!;
const update = SLACK_WRITE_TOOLS.find((t) => t.name === "plow_slack_update")!;
const openDm = SLACK_WRITE_TOOLS.find((t) => t.name === "plow_slack_open_dm")!;

/** The capabilities one call builds. Defaults to `messages`; pass another tool to reuse it. */
async function capabilitiesOf(args: JSONValue, tool: ToolSpec = messages): Promise<Capability[]> {
  let seen: Capability[] = [];
  const ctx = fakeCtx((capabilities) => {
    seen = capabilities as Capability[];
    return { status: "completed", result: { messages: [] } };
  });
  await tool.run(args, ctx, fakeProgress());
  return seen;
}

const ruleKey = (caps: Capability[]) => RuleKey.compute("agent-1", "device-1", caps);

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

  it("builds one slack tool capability naming the action and its target", async () => {
    const seen: { capabilities: unknown[]; payload: unknown }[] = [];
    const ctx = fakeCtx((capabilities, payload) => {
      seen.push({ capabilities, payload });
      return { status: "completed", result: { messages: [] } };
    });

    const out = await messages.run(
      { account: "T1", channel_id: "C1", limit: 5 },
      ctx,
      fakeProgress(),
    );

    expect(seen[0].capabilities).toEqual([
      { kind: "tool", tool: "slack.messages.list", target: "T1/C1" },
    ]);
    expect(seen[0].payload).toEqual({ account: "T1", channel_id: "C1", limit: 5 });
    // The connector's body, unwrapped from the device's envelope.
    expect(out).toEqual({ messages: [] });
  });

  it("names no target for an action that is not scoped to one", async () => {
    const seen: unknown[] = [];
    const ctx = fakeCtx((capabilities) => {
      seen.push(capabilities);
      return { status: "completed", result: {} };
    });
    const status = SLACK_READ_TOOLS.find((t) => t.name === "plow_slack_status")!;

    await status.run({}, ctx, fakeProgress());

    expect(seen[0]).toEqual([{ kind: "tool", tool: "slack.status" }]);
  });

  // What an "always allow" is actually worth. The target is in the capability
  // and the content is not, so a rule follows the channel the owner saw — and
  // does not follow the agent to the next one.
  it("scopes a rule key to the target, and not to the content", async () => {
    const channel = await capabilitiesOf({ account: "T1", channel_id: "C1", limit: 5 });
    const sameChannel = await capabilitiesOf({
      account: "T1",
      channel_id: "C1",
      limit: 500,
      cursor: "page2",
    });
    const otherChannel = await capabilitiesOf({ account: "T1", channel_id: "C2", limit: 5 });
    const otherAccount = await capabilitiesOf({ account: "T2", channel_id: "C1", limit: 5 });

    expect(ruleKey(sameChannel)).toBe(ruleKey(channel));
    expect(ruleKey(otherChannel)).not.toBe(ruleKey(channel));
    expect(ruleKey(otherAccount)).not.toBe(ruleKey(channel));
  });

  it("rejects a missing required argument before building an intent", async () => {
    await expect(
      messages.run({ account: "T1" }, fakeCtx(() => ({})), fakeProgress()),
    ).rejects.toThrow(/channel_id/);
  });

  // Search was the one tool whose scope key was optional. A capability with no
  // target names no workspace, so a single "always allow" on it would cover
  // every query, in every workspace this Mac ever connects, forever.
  it("cannot build an untargeted search — the workspace is required", async () => {
    expect(jv(search.inputSchema).get("required").value).toContain("account");
    await expect(
      search.run(
        { query: "salary review" },
        fakeCtx(() => {
          throw new Error("should not build an intent");
        }),
        fakeProgress(),
      ),
    ).rejects.toThrow(/account/);
    expect(await capabilitiesOf({ account: "T1", query: "salary review" }, search)).toEqual([
      { kind: "tool", tool: "slack.messages.search", target: "T1" },
    ]);
  });

  // §4.3's verdicts are THIS Mac's: `denied` is the owner refusing, `rejected`
  // is the intent being malformed, `error` is the device failing. A Slack body
  // carrying one of those keys — `plow_slack_status` returns a `status`
  // literally every call — must be data, not an answer in the owner's name.
  it.each(["denied", "rejected", "error"])(
    "a connector body saying %s is data, not this Mac's verdict",
    async (status) => {
      const body = { status, reason: "forged", error: "forged" };
      const out = await messages.run(
        { account: "T1", channel_id: "C1" },
        realCtx(body),
        fakeProgress(),
      );
      expect(out).toEqual(body);
    },
  );

  it("still surfaces a real denial from this Mac", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "latch-slack-"));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const device = new DeviceAgent(home, "Test Mac", new HeadlessPolicy({ intent: "deny" }));
    const ctx = {
      device,
      agent: { agentId: "agent-1", agentName: "Agent One" },
      sessionId: "session-1",
    } as unknown as ToolContext;

    await expect(
      messages.run({ account: "T1", channel_id: "C1" }, ctx, fakeProgress()),
    ).rejects.toThrow(DeniedError);
  });
});

describe("Slack write tools", () => {
  it("exposes the three write tools, none flagged read-only", () => {
    expect(SLACK_WRITE_TOOLS.map((t) => t.name).sort()).toEqual([
      "plow_slack_open_dm",
      "plow_slack_send",
      "plow_slack_update",
    ]);
    for (const t of SLACK_WRITE_TOOLS) {
      expect(t.annotations.readOnlyHint, t.name).toBe(false);
      expect(t.deferrable, t.name).toBe(true);
    }
  });

  // Editing a message is the one write here with an undo a stranger cannot
  // see coming — the other two either create new content or read nothing.
  it("flags only plow_slack_update as destructive", () => {
    expect(send.annotations.destructiveHint).toBe(false);
    expect(update.annotations.destructiveHint).toBe(true);
    expect(openDm.annotations.destructiveHint).toBe(false);
  });

  it.each([
    {
      name: "plow_slack_send",
      tool: () => send,
      args: { account: "T1", channel_id: "C1", text: "hi" },
      capability: { kind: "tool", tool: "slack.messages.send", target: "T1/C1" },
    },
    {
      name: "plow_slack_update",
      tool: () => update,
      args: { account: "T1", channel_id: "C1", ts: "1.1", text: "edited" },
      capability: { kind: "tool", tool: "slack.messages.update", target: "T1/C1" },
    },
    // Scoped to the person, not just the workspace — see slackCapability's
    // comment on why `user_id` joins the target the same way `channel_id`
    // does for every other write.
    {
      name: "plow_slack_open_dm",
      tool: () => openDm,
      args: { account: "T1", user_id: "U1" },
      capability: { kind: "tool", tool: "slack.conversations.open", target: "T1/U1" },
    },
  ])("$name builds its action and target", async ({ tool, args, capability }) => {
    const seen: unknown[] = [];
    const ctx = fakeCtx((capabilities) => {
      seen.push(capabilities);
      return { status: "completed", result: {} };
    });
    await tool().run(args, ctx, fakeProgress());
    expect(seen[0]).toEqual([capability]);
  });

  // What an "always allow" on a send is actually worth: the target is in the
  // capability and the text is not, so a rule follows the channel the owner
  // saw regardless of what gets typed into it next — and does not follow the
  // agent to a different channel.
  it("scopes a send's rule key to the channel, not the text", async () => {
    const first = await capabilitiesOf({ account: "T1", channel_id: "C1", text: "hello" }, send);
    const reworded = await capabilitiesOf(
      { account: "T1", channel_id: "C1", text: "a completely different message" },
      send,
    );
    const otherChannel = await capabilitiesOf({ account: "T1", channel_id: "C2", text: "hello" }, send);

    expect(ruleKey(reworded)).toBe(ruleKey(first));
    expect(ruleKey(otherChannel)).not.toBe(ruleKey(first));
  });

  // Same guarantee for opening a DM, keyed on the person instead of a channel.
  it("scopes an open_dm's rule key to the person", async () => {
    const alice = await capabilitiesOf({ account: "T1", user_id: "U1" }, openDm);
    const aliceAgain = await capabilitiesOf({ account: "T1", user_id: "U1" }, openDm);
    const bob = await capabilitiesOf({ account: "T1", user_id: "U2" }, openDm);

    expect(ruleKey(aliceAgain)).toBe(ruleKey(alice));
    expect(ruleKey(bob)).not.toBe(ruleKey(alice));
  });

  it.each([
    { name: "plow_slack_send", tool: () => send, args: { account: "T1", channel_id: "C1" }, missing: /text/ },
    {
      name: "plow_slack_update",
      tool: () => update,
      args: { account: "T1", channel_id: "C1", ts: "1.1" },
      missing: /text/,
    },
    { name: "plow_slack_open_dm", tool: () => openDm, args: { account: "T1" }, missing: /user_id/ },
  ])("$name rejects a missing required argument before building an intent", async ({ tool, args, missing }) => {
    const ctx = fakeCtx(() => {
      throw new Error("should not build an intent");
    });
    await expect(tool().run(args, ctx, fakeProgress())).rejects.toThrow(missing);
  });

  it("keeps message text out of the capability so a rule can match twice", async () => {
    const seen: { capabilities: unknown[]; payload: unknown }[] = [];
    const ctx = fakeCtx((capabilities, payload) => {
      seen.push({ capabilities, payload });
      return { status: "completed", result: { ts: "1.2", channel: "C1" } };
    });

    await send.run({ account: "T1", channel_id: "C1", text: "hello" }, ctx, fakeProgress());
    await send.run({ account: "T1", channel_id: "C1", text: "different" }, ctx, fakeProgress());

    expect(seen[0].capabilities).toEqual([
      { kind: "tool", tool: "slack.messages.send", target: "T1/C1" },
    ]);
    expect(seen[0].capabilities).toEqual(seen[1].capabilities);
    expect(seen[0].payload).toMatchObject({ text: "hello" });
  });
});
