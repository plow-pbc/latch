import { describe, expect, it, vi } from "vitest";
import { cloudAgentsIpcResult } from "../src/cloudAgentsIpc.js";
import type { CloudAgentsUiState } from "../src/cloudAgentState.js";

describe("cloud:agents IPC result", () => {
  it("returns only agents and their error while a line activation is pending", async () => {
    const pendingState: CloudAgentsUiState = {
      cloudAgents: [],
      cloudProviders: [{ id: "provider-secret", name: "Provider" }],
      cloudProvidersError: "provider error",
      cloudFreeLines: [{ uid: "line-free", displayName: "Free", number: "+15550100" }],
      cloudLineFlow: {
        phase: "waiting",
        activation: {
          displayCode: "PRIVATE",
          sendTo: "+15550101",
          smsBody: "private activation body",
        },
        message: null,
        completedAgentId: null,
        retryNewLine: false,
        terminal: null,
      },
      cloudAgentsError: null,
      cloudChatsError: "chat error",
      cloudChatsNeedReactivation: true,
      cloudActionError: "action error",
      cloudChatsLoaded: true,
    };
    const source = {
      refresh: vi.fn(async () => {}),
      state: vi.fn(() => pendingState),
    };

    const result = await cloudAgentsIpcResult(source);

    expect(source.refresh).toHaveBeenCalledOnce();
    expect(result).toEqual({ cloudAgents: [], cloudAgentsError: null });
    expect(Object.keys(result!)).toEqual(["cloudAgents", "cloudAgentsError"]);
  });
});
