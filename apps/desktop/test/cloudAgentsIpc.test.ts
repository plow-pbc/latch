import { describe, expect, it, vi } from "vitest";
import { cloudAgentsIpcResult } from "../src/cloudAgentsIpc.js";
import type { CloudAgentsUiState } from "../src/cloudAgentState.js";

describe("cloud:agents IPC result", () => {
  it("returns only agents and their error without exposing the provider catalog", async () => {
    const pendingState: CloudAgentsUiState = {
      cloudAgents: [],
      cloudProviders: [{ id: "provider-secret", name: "Provider", phrase: "Start Provider" }],
      cloudProvidersError: "provider error",
      cloudFreeLines: [{ uid: "line-free", displayName: "Free", number: "+15550100" }],
      cloudAgentsError: null,
      cloudChatsError: "chat error",
      cloudChatsNeedReactivation: true,
      cloudActionError: "action error",
      cloudChatsLoaded: true,
      cloudLinesLoaded: true,
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
