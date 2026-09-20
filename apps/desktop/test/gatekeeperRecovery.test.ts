import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dismissGatekeeperAttention,
  gatekeeperRecoveryView,
  representativeCommands,
  suggestGatekeeperRevision,
} from "../src/gatekeeperRecovery.js";
import { makeIntent } from "@domo/protocol";

const CREDENTIAL = "plow_sk_gatekeeper_recovery_secret";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ revision: "You are a tool a family assistant uses; you are authorized to make purchases for the family." }) } }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

describe("dismissGatekeeperAttention", () => {
  const newer = {
    intentId: "newer",
    agent: "Family assistant",
    request: "Send the itinerary",
    capabilities: ["Network: allowed"],
    reason: "Not covered",
  };

  it("clears only the denial the owner actually dismissed", () => {
    expect(dismissGatekeeperAttention(newer, "newer")).toBeNull();
    expect(dismissGatekeeperAttention(newer, "older")).toBe(newer);
    expect(dismissGatekeeperAttention(null, "newer")).toBeNull();
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("representativeCommands", () => {
  it("takes ten recent, distinct local requests and omits the denied one", () => {
    const rows = [
      { intentId: "denied", title: "Buy Lego", command: "open amazon" },
      { intentId: null, title: "Browser session closed", command: null },
      { intentId: "12", title: "Book a dentist appointment", command: null },
      { intentId: "11", title: "Order groceries", command: null },
      { intentId: "10", title: "Order groceries", command: null },
      ...Array.from({ length: 12 }, (_, i) => ({ intentId: String(9 - i), title: `Task ${9 - i}`, command: null })),
    ];

    expect(representativeCommands(rows, "denied")).toEqual([
      "Book a dentist appointment",
      "Order groceries",
      "Task 9",
      "Task 8",
      "Task 7",
      "Task 6",
      "Task 5",
      "Task 4",
      "Task 3",
      "Task 2",
    ]);
  });
});

describe("gatekeeperRecoveryView", () => {
  it("projects only the owner-facing request, capabilities, and reason", () => {
    const intent = makeIntent({
      agentId: "agent-1",
      agentDisplay: "Family assistant",
      deviceId: "device-1",
      request: "Buy the Lego set",
      capabilities: [{ kind: "network", allowed: true }],
      sessionId: "s1",
    });
    expect(gatekeeperRecoveryView({ intent, reason: "Purchase is outside the purpose." })).toEqual({
      intentId: intent.intentId,
      agent: "Family assistant",
      request: "Buy the Lego set",
      capabilities: ["Network: allowed"],
      reason: "Purchase is outside the purpose.",
    });
  });
});

describe("suggestGatekeeperRevision", () => {
  const suggest = () => suggestGatekeeperRevision({
    currentPurpose: "You are a tool a family assistant uses.",
    deniedRequest: "Buy a $125 Lego set on Amazon",
    capabilities: ["Browser: amazon.com"],
    typicalCommands: ["Order groceries", "Book a dentist appointment"],
    plowCredential: CREDENTIAL,
    apiBaseUrl: "https://api.plow.co",
  });

  it("asks for a full generalized replacement, not an exact-request exception", async () => {
    await suggest();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const [system, user] = body.messages;

    expect(system.content).toContain("allow commands similar to the denied command");
    expect(system.content).toContain("full replacement");
    expect(system.content).toContain("purpose and effect");
    expect(system.content).toContain("merchant, product, amount, path, recipient");
    expect(system.content).toContain("Preserve every unrelated restriction");
    expect(system.content).toContain("You are a tool a family assistant uses.");
    expect(user.content).toContain("Buy a $125 Lego set on Amazon");
    expect(user.content).toContain("Order groceries");
    expect(body.response_format.json_schema.schema).toEqual({
      type: "object",
      properties: { revision: { type: "string" } },
      required: ["revision"],
      additionalProperties: false,
    });
    expect(JSON.stringify(body)).not.toContain(CREDENTIAL);
  });

  it("returns a proposal without changing the current purpose", async () => {
    await expect(suggest()).resolves.toEqual({
      ok: true,
      revision: "You are a tool a family assistant uses; you are authorized to make purchases for the family.",
    });
  });

  it("rejects malformed, empty, overlong, and credential-echo answers", async () => {
    const answers = [
      "not json",
      JSON.stringify({ revision: "" }),
      JSON.stringify({ revision: "x".repeat(8_001) }),
      JSON.stringify({ revision: `Allow ${CREDENTIAL}` }),
      JSON.stringify({ revision: `Allow ${Buffer.from(CREDENTIAL).toString("base64")}` }),
      JSON.stringify({
        revision: `Allow ${Array.from(CREDENTIAL, (char) =>
          `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join("")}`,
      }),
    ];
    for (const content of answers) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }));
      await expect(suggest()).resolves.toEqual({ ok: false, reason: "Gatekeeper could not produce a safe revision" });
    }
  });
});
