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
 * intent the tool built, rather than a real `DeviceAgent` — the shape used in
 * mcpServer.test.ts, minus the parts these tools never touch (`decideAndRun`
 * only reads `ctx.device.identity.deviceId` and calls `ctx.device.handleIntent`).
 */
function fakeCtx(
  handleIntent: (capabilities: unknown[], payload: unknown, request: string) => JSONValue,
): ToolContext {
  return {
    device: {
      identity: { deviceId: "device-1" },
      handleIntent: async (
        intent: { capabilities: unknown[]; request: string },
        payload: unknown,
      ) => handleIntent(intent.capabilities, payload, intent.request),
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

const status = SLACK_READ_TOOLS.find((t) => t.name === "plow_slack_status")!;
const messages = SLACK_READ_TOOLS.find((t) => t.name === "plow_slack_messages")!;
const channels = SLACK_READ_TOOLS.find((t) => t.name === "plow_slack_channels")!;
const users = SLACK_READ_TOOLS.find((t) => t.name === "plow_slack_users")!;
const search = SLACK_READ_TOOLS.find((t) => t.name === "plow_slack_search")!;
const send = SLACK_WRITE_TOOLS.find((t) => t.name === "plow_slack_send")!;
const update = SLACK_WRITE_TOOLS.find((t) => t.name === "plow_slack_update")!;
const openDm = SLACK_WRITE_TOOLS.find((t) => t.name === "plow_slack_open_dm")!;

/** The intent one call builds: the enforceable half, and what rides beside it. */
async function intentOf(
  args: JSONValue,
  tool: ToolSpec,
): Promise<{ capabilities: Capability[]; payload: unknown }> {
  let seen: { capabilities: Capability[]; payload: unknown } = { capabilities: [], payload: null };
  const ctx = fakeCtx((capabilities, payload) => {
    seen = { capabilities: capabilities as Capability[], payload };
    return { status: "completed", result: {} };
  });
  await tool.run(args, ctx, fakeProgress());
  return seen;
}

/** The `request` line one call composes — the display channel a reviewer reads. */
async function requestOf(args: JSONValue, tool: ToolSpec): Promise<string> {
  let request = "";
  const ctx = fakeCtx((_capabilities, _payload, composed) => {
    request = composed;
    return { status: "completed", result: {} };
  });
  await tool.run(args, ctx, fakeProgress());
  return request;
}

const ruleKeyOf = async (args: JSONValue, tool: ToolSpec): Promise<string> =>
  RuleKey.compute("agent-1", "device-1", (await intentOf(args, tool)).capabilities);

/**
 * The declared surface, in one table. `readOnlyHint` and `destructiveHint` are
 * hints for display and routing, never bounds — what a call may actually do is
 * the capability the owner approved. Editing a message is the one write with
 * an undo a stranger cannot see coming; the other two either create new
 * content or read nothing.
 */
it("is these eight tools, with these hints", () => {
  const surface = [...SLACK_READ_TOOLS, ...SLACK_WRITE_TOOLS].map((t) => [
    t.name,
    t.annotations.readOnlyHint,
    t.annotations.destructiveHint,
    t.deferrable,
  ]);
  expect(surface).toEqual([
    ["plow_slack_status", true, undefined, true],
    ["plow_slack_channels", true, undefined, true],
    ["plow_slack_users", true, undefined, true],
    ["plow_slack_messages", true, undefined, true],
    ["plow_slack_search", true, undefined, true],
    ["plow_slack_send", false, false, true],
    ["plow_slack_update", false, true, true],
    ["plow_slack_open_dm", false, false, true],
  ]);
});

/**
 * The split this whole module is built on: the capability names the action and
 * the target it is confined to, and the arguments that are content — not scope
 * — ride the payload. That is `fs.write`'s split, and for its reason: an
 * "always allow" is on the channel the owner saw, and message text never
 * enters a rule key.
 */
describe("what one call is confined to", () => {
  it.each([
    // No account, no channel: `status` asks which workspaces exist, so it is
    // confined to none — and says so rather than implying a scope.
    {
      name: "plow_slack_status",
      tool: () => status,
      args: { goal: "see if Slack is connected" },
      capability: { kind: "tool", tool: "slack.status" },
      payload: {},
    },
    // Scoped to the workspace only, like `search` below — a channel list has
    // no channel yet to scope it to.
    {
      name: "plow_slack_channels",
      tool: () => channels,
      args: { account: "T1", limit: 5 },
      capability: { kind: "tool", tool: "slack.channels.list", target: "T1" },
      payload: { account: "T1", limit: 5 },
    },
    {
      name: "plow_slack_users",
      tool: () => users,
      args: { account: "T1", limit: 5 },
      capability: { kind: "tool", tool: "slack.users.list", target: "T1" },
      payload: { account: "T1", limit: 5 },
    },
    // `goal` is in the args and not in the payload: only the keys Plow's
    // endpoint accepts are copied, never the whole arg bag.
    {
      name: "plow_slack_messages",
      tool: () => messages,
      args: { account: "T1", channel_id: "C1", limit: 5, cursor: "p2", goal: "catch up" },
      capability: { kind: "tool", tool: "slack.messages.list", target: "T1/C1" },
      payload: { account: "T1", channel_id: "C1", limit: 5, cursor: "p2" },
    },
    // A search names the workspace it searches. It was the one tool whose
    // scope key was optional, and an untargeted capability would have made a
    // rule that matched every query in every workspace this Mac connects.
    {
      name: "plow_slack_search",
      tool: () => search,
      args: { account: "T1", query: "salary review", limit: 5 },
      capability: { kind: "tool", tool: "slack.messages.search", target: "T1" },
      payload: { account: "T1", query: "salary review", limit: 5 },
    },
    {
      name: "plow_slack_send",
      tool: () => send,
      args: { account: "T1", channel_id: "C1", text: "hi", thread_ts: "1.0" },
      capability: { kind: "tool", tool: "slack.messages.send", target: "T1/C1" },
      payload: { account: "T1", channel_id: "C1", text: "hi", thread_ts: "1.0" },
    },
    {
      name: "plow_slack_update",
      tool: () => update,
      args: { account: "T1", channel_id: "C1", ts: "1.1", text: "edited" },
      capability: { kind: "tool", tool: "slack.messages.update", target: "T1/C1" },
      payload: { account: "T1", channel_id: "C1", ts: "1.1", text: "edited" },
    },
    // Scoped to the person, not just the workspace — see slackCapability's
    // comment on why `user_id` joins the target the way `channel_id` does.
    {
      name: "plow_slack_open_dm",
      tool: () => openDm,
      args: { account: "T1", user_id: "U1" },
      capability: { kind: "tool", tool: "slack.conversations.open", target: "T1/U1" },
      payload: { account: "T1", user_id: "U1" },
    },
  ])("$name names its action and target; content rides the payload", async (row) => {
    expect(await intentOf(row.args, row.tool())).toEqual({
      capabilities: [row.capability],
      payload: row.payload,
    });
  });

  // What an "always allow" is actually worth: the rule follows the target the
  // owner saw, whatever is typed into it next, and does not follow the agent
  // to the next channel, workspace or person.
  it.each([
    {
      name: "a channel read",
      tool: () => messages,
      args: { account: "T1", channel_id: "C1", limit: 5 },
      sameTarget: { account: "T1", channel_id: "C1", limit: 500, cursor: "page2" },
      elsewhere: [
        { account: "T1", channel_id: "C2", limit: 5 },
        { account: "T2", channel_id: "C1", limit: 5 },
      ],
    },
    {
      name: "a send",
      tool: () => send,
      args: { account: "T1", channel_id: "C1", text: "hello" },
      sameTarget: { account: "T1", channel_id: "C1", text: "a completely different message" },
      elsewhere: [{ account: "T1", channel_id: "C2", text: "hello" }],
    },
    {
      name: "an opened DM",
      tool: () => openDm,
      args: { account: "T1", user_id: "U1" },
      sameTarget: { account: "T1", user_id: "U1" },
      elsewhere: [{ account: "T1", user_id: "U2" }],
    },
  ])("$name keys its rule on the target, not the content", async (row) => {
    const key = await ruleKeyOf(row.args, row.tool());
    expect(await ruleKeyOf(row.sameTarget, row.tool())).toBe(key);
    for (const other of row.elsewhere) {
      expect(await ruleKeyOf(other, row.tool())).not.toBe(key);
    }
  });

  // Both layers, because they fail differently: without the schema entry a
  // client lets the call through to us, and without the guard we would build
  // an intent whose capability names a scope nobody supplied.
  it.each([
    { name: "plow_slack_channels", tool: () => channels, args: {}, missing: "account" },
    { name: "plow_slack_users", tool: () => users, args: {}, missing: "account" },
    {
      name: "plow_slack_messages",
      tool: () => messages,
      args: { account: "T1" },
      missing: "channel_id",
    },
    { name: "plow_slack_search", tool: () => search, args: { query: "pay" }, missing: "account" },
    {
      name: "plow_slack_send",
      tool: () => send,
      args: { account: "T1", channel_id: "C1" },
      missing: "text",
    },
    {
      name: "plow_slack_update",
      tool: () => update,
      args: { account: "T1", channel_id: "C1", ts: "1.1" },
      missing: "text",
    },
    { name: "plow_slack_open_dm", tool: () => openDm, args: { account: "T1" }, missing: "user_id" },
  ])("$name will not build an intent without $missing", async (row) => {
    expect(jv(row.tool().inputSchema).get("required").value).toContain(row.missing);
    const ctx = fakeCtx(() => {
      throw new Error("should not build an intent");
    });
    await expect(row.tool().run(row.args, ctx, fakeProgress())).rejects.toThrow(row.missing);
  });
});

describe("this Mac's verdict is not Slack's", () => {
  // §4.3's verdicts are THIS Mac's: `denied` is the owner refusing, `rejected`
  // is the intent being malformed, `error` is the device failing. A Slack body
  // carrying one of those keys — `plow_slack_status` returns a `status`
  // literally every call — must be data, not an answer in the owner's name.
  // Passing through unchanged also shows the connector's own body arriving
  // unwrapped from the device's `{status, result}` envelope.
  it.each(["denied", "rejected", "error"])(
    "a connector body saying %s is data, not this Mac's verdict",
    async (forged) => {
      const body = { status: forged, reason: "forged", error: "forged" };
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

/**
 * `request` is the only channel that says WHAT a call does: the capability
 * names the action and the target it is confined to, and deliberately carries
 * no content, so a rule can match twice. Every pre-existing tool puts its
 * operative selector here — `read file: <path>`, `run: <argv>` — and both
 * consumers already treat the string as data (the reviewer prompt JSON-encodes
 * it, the renderer sets it with textContent). Left static, the gate saw less
 * of a Slack call than of any other tool on this Mac.
 */
describe("the request line", () => {
  it.each([
    { args: {}, tool: () => status, request: "check Slack connection" },
    {
      args: { account: "T1", limit: 500 },
      tool: () => channels,
      request: "list Slack channels: T1 (up to 500)",
    },
    { args: { account: "T1" }, tool: () => users, request: "list Slack users: T1" },
    {
      args: { account: "T1", channel_id: "C1", limit: 20 },
      tool: () => messages,
      request: "read Slack messages: C1 (up to 20)",
    },
    // Verbatim, because for a search the query IS the read scope — the thing
    // the reviewer is told to weigh as "a broad acquisition of data".
    {
      args: { account: "T1", query: "salary review OR severance" },
      tool: () => search,
      request: "search Slack: salary review OR severance",
    },
    {
      args: { account: "T1", channel_id: "C1", text: "ship it" },
      tool: () => send,
      request: "send a Slack message to C1: ship it",
    },
    {
      args: { account: "T1", channel_id: "C1", ts: "1.1", text: "never mind" },
      tool: () => update,
      request: "edit the Slack message 1.1 in C1 to: never mind",
    },
    { args: { account: "T1", user_id: "U1" }, tool: () => openDm, request: "open a Slack DM: U1" },
  ])("reads '$request'", async (row) => {
    expect(await requestOf(row.args, row.tool())).toBe(row.request);
  });

  // The capability chips are the enforceable half of the dialog. A message
  // long enough to scroll them off screen would hide what is being granted.
  it("bounds a message excerpt, so the capability chips stay on screen", async () => {
    const request = await requestOf(
      { account: "T1", channel_id: "C1", text: "x".repeat(5_000) },
      send,
    );
    expect(request).toContain(`C1: ${"x".repeat(200)}…`);
    expect(request.length).toBeLessThan(260);
  });
});
