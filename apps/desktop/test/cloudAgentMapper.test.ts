import { describe, expect, it } from "vitest";
import {
  joinCloudAgentsWithKeys,
  toCloudAgentDisplayRow,
} from "../src/cloudAgentMapper.js";
import { CloudAgentResource, isTerminalCloudAgent } from "../src/cloudAgents.js";

function agent(overrides: Partial<CloudAgentResource> = {}): CloudAgentResource {
  return {
    agentId: "agent_stable",
    chatUid: "cht_123",
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
  it("maps a create receipt to the renderer row without URL or session identity", () => {
    const row = toCloudAgentDisplayRow(agent(), {
      fallbackName: "Kitchen agent",
      chatLabel: "+1 415 555 0100 · Pat, Lee",
    });

    expect(row).toEqual({
      agentId: "agent_stable",
      name: "Kitchen agent",
      chatUid: "cht_123",
      chatLabel: "+1 415 555 0100 · Pat, Lee",
      provider: "exe:hermes",
      status: "provisioning",
      failureReason: null,
      createdAt: "2026-08-24T18:02:11Z",
    });
    expect(JSON.stringify(row)).not.toContain("session_old");
    expect(JSON.stringify(row)).not.toContain("provider.internal");
  });

  it("recognizes only active and failed as terminal", () => {
    expect(isTerminalCloudAgent(agent({ status: "provisioning" }))).toBe(false);
    expect(isTerminalCloudAgent(agent({ status: "active" }))).toBe(true);
    expect(isTerminalCloudAgent(agent({ status: "failed" }))).toBe(true);
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
