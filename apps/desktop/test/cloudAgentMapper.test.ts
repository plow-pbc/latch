import { describe, expect, it } from "vitest";
import {
  toCloudAgentDisplayRow,
} from "../src/cloudAgentMapper.js";
import { CloudAgentResource, isTerminalCloudAgent } from "../src/cloudAgents.js";

function agent(overrides: Partial<CloudAgentResource> = {}): CloudAgentResource {
  return {
    agentId: "agent_stable",
    line: null, credential: null, settings: {}, image: null,
    url: "https://provider.internal/secret-handle",
    provider: "exe:hermes",
    name: "Kitchen",
    status: "provisioning",
    failureCode: null,
    createdAt: "2026-08-24T18:02:11Z",
    ...overrides,
  };
}

describe("cloud-agent pure mappings", () => {
  it("keeps provider URL and session identity out of renderer state", () => {
    const row = toCloudAgentDisplayRow(agent(), {
      line: { uid: "lin_willow", label: "Willow · +1 415-555-0100" },
      canMessage: true,
      canRetry: true,
      threads: [{ uid: "cht_123", label: "+1 415 555 0100 · Pat, Lee" }],
    });

    expect(row).toMatchObject({
      agentId: "agent_stable",
      line: { uid: "lin_willow", label: "Willow · +1 415-555-0100" },
      canMessage: true,
      canRetry: true,
      threads: [{ uid: "cht_123", label: "+1 415 555 0100 · Pat, Lee" }],
    });
    expect(row).not.toHaveProperty("credential");
    expect(JSON.stringify(row)).not.toContain("provider.internal");
  });

  it("renders known failure labels and a fixed unknown-failure message into the renderer", () => {
    const row = toCloudAgentDisplayRow({
      ...agent({ status: "failed" }),
      failureCode: "validation_failed",
    } as CloudAgentResource);

    expect(row.failureReason).toMatch(/validation failed.*retrying will not help.*human/i);

    const future = toCloudAgentDisplayRow({
      ...agent({ status: "failed" }),
      failureCode: "capacity_exhausted",
    } as CloudAgentResource);
    expect(future.failureReason).toBe("Agent operation failed");

    const encodedCredential = toCloudAgentDisplayRow({
      ...agent({ status: "failed" }),
      failureCode: "cGxvd19za19kZXZpY2VfZG9fbm90X2xlYWs=",
    } as CloudAgentResource);
    expect(encodedCredential.failureReason).toBe("Agent operation failed");
  });

  it("keeps provisioning non-terminal and treats every returned status as terminal", () => {
    expect(isTerminalCloudAgent(agent({ status: "provisioning" }))).toBe(false);
    expect(isTerminalCloudAgent(agent({ status: "running" }))).toBe(true);
    expect(isTerminalCloudAgent(agent({ status: "teardown" }))).toBe(true);
    expect(isTerminalCloudAgent(agent({ status: "provider_verifying" }))).toBe(true);
  });
});
