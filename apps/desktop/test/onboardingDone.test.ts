import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS renderer helper, shipped as-is.
import { loadDoneAgent } from "../src/renderer/onboardingDone.js";

describe("the onboarding Done agent", () => {
  it("uses the first agent the cloud bridge says can be messaged", async () => {
    const agent = await loadDoneAgent(async () => ({
      cloudAgentsError: null,
      cloudAgents: [
        { agentId: "agent_unresolved", name: "Ash", canMessage: false },
        { agentId: "agent_elm", name: "Elm", canMessage: true },
      ],
    }));

    expect(agent).toMatchObject({ agentId: "agent_elm", name: "Elm" });
  });

  it("offers no message action when no agent has a resolved line", async () => {
    expect(await loadDoneAgent(async () => ({
      cloudAgentsError: null,
      cloudAgents: [{ agentId: "agent_ash", name: "Ash", canMessage: false }],
    }))).toBeNull();
  });

  it("keeps a cloud lookup failure silent", async () => {
    expect(await loadDoneAgent(async () => {
      throw new Error("offline");
    })).toBeNull();
    expect(await loadDoneAgent(async () => ({
      cloudAgentsError: "Something went wrong. Try again.",
      cloudAgents: [{ agentId: "agent_elm", name: "Elm", canMessage: true }],
    }))).toBeNull();
  });
});
