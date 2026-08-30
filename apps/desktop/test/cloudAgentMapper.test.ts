import { describe, expect, it } from "vitest";
import {
  joinCloudAgentsWithKeys,
  toCloudAgentDisplayRow,
} from "../src/cloudAgentMapper.js";
import { CloudAgentResource, isTerminalCloudAgent } from "../src/cloudAgents.js";

function agent(overrides: Partial<CloudAgentResource> = {}): CloudAgentResource {
  return {
    agentId: "agent_stable",
    chatUids: ["cht_123"],
    url: "https://provider.internal/secret-handle",
    provider: "exe:hermes",
    name: null,
    status: "provisioning",
    failureReason: null,
    createdAt: "2026-08-24T18:02:11Z",
    sessionId: "session_old",
    ...overrides,
  };
}

describe("cloud-agent pure mappings", () => {
  it("keeps provider URL and session identity out of renderer state", () => {
    const row = toCloudAgentDisplayRow(agent(), {
      line: { uid: "lin_willow", label: "Willow · +1 415-555-0100" },
      threads: [{ uid: "cht_123", label: "+1 415 555 0100 · Pat, Lee" }],
    });

    expect(row).toMatchObject({
      agentId: "agent_stable",
      line: { uid: "lin_willow", label: "Willow · +1 415-555-0100" },
      threads: [{ uid: "cht_123", label: "+1 415 555 0100 · Pat, Lee" }],
    });
    expect(JSON.stringify(row)).not.toContain("session_old");
    expect(JSON.stringify(row)).not.toContain("provider.internal");
  });

  it("scrubs a session id embedded in every renderer-bound display string", () => {
    const sessionId = "session_sensitive_123";
    const row = toCloudAgentDisplayRow(
      agent({
        agentId: `agent-${sessionId}`,
        chatUids: [`chat-${sessionId}`],
        name: `name ${sessionId}`,
        provider: `provider ${sessionId}`,
        failureReason: `credential ${sessionId} rejected`,
        createdAt: `created ${sessionId}`,
        sessionId,
      }),
      {
        line: { uid: `line-${sessionId}`, label: `line label ${sessionId}` },
        threads: [{ uid: `chat-${sessionId}`, label: `chat label ${sessionId}` }],
      },
    );

    expect(row.failureReason).toBe("credential [credential] rejected");
    expect(JSON.stringify(row)).not.toContain(sessionId);
  });

  it("allows only known failure labels or legacy prose into the renderer", () => {
    const row = toCloudAgentDisplayRow({
      ...agent({ status: "failed", failureReason: "legacy reason" }),
      failureCode: "validation_failed",
    } as CloudAgentResource);

    expect(row.failureReason).toMatch(/validation failed.*retrying will not help.*human/i);

    const future = toCloudAgentDisplayRow({
      ...agent({ status: "failed", failureReason: "Provider capacity is exhausted." }),
      failureCode: "capacity_exhausted",
    } as CloudAgentResource);
    expect(future.failureReason).toBe("Provider capacity is exhausted.");

    const encodedCredential = toCloudAgentDisplayRow({
      ...agent({ status: "failed", failureReason: null }),
      failureCode: "cGxvd19za19kZXZpY2VfZG9fbm90X2xlYWs=",
    } as CloudAgentResource);
    expect(encodedCredential.failureReason).toBeNull();
  });

  it("keeps provisioning non-terminal and treats every returned status as terminal", () => {
    expect(isTerminalCloudAgent(agent({ status: "provisioning" }))).toBe(false);
    expect(isTerminalCloudAgent(agent({ status: "running" }))).toBe(true);
    expect(isTerminalCloudAgent(agent({ status: "teardown" }))).toBe(true);
    expect(isTerminalCloudAgent(agent({ status: "provider_verifying" }))).toBe(true);
  });

  it("joins KeyInfo by stable agent_id even after session_id rotates", () => {
    const key = { id: 17, agent_id: "agent_stable", session_id: "credential_new" };
    const before = joinCloudAgentsWithKeys([agent({ sessionId: "session_old" })], [key]);
    const after = joinCloudAgentsWithKeys([agent({ sessionId: "session_new" })], [key]);

    expect(before[0].key).toBe(key);
    expect(after[0].key).toBe(key);
    expect(joinCloudAgentsWithKeys([agent()], [{ id: 18, agent_id: null }])[0].key).toBeNull();
  });
});
