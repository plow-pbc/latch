import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS renderer helper, shipped as-is.
import { loadDoneAgent } from "../src/renderer/onboardingDone.js";

describe("the onboarding Done agent", () => {
  it.each([
    {
      caseName: "messageable agent",
      load: async () => ({
        cloudAgentsError: null,
        cloudAgents: [
          { agentId: "agent_unresolved", name: "Ash", canMessage: false },
          { agentId: "agent_elm", name: "Elm", canMessage: true },
        ],
      }),
      expected: { agentId: "agent_elm", name: "Elm", canMessage: true },
    },
    {
      caseName: "none",
      load: async () => ({
        cloudAgentsError: null,
        cloudAgents: [{ agentId: "agent_ash", name: "Ash", canMessage: false }],
      }),
      expected: null,
    },
    {
      caseName: "rejected loader",
      load: async () => { throw new Error("offline"); },
      expected: null,
    },
    {
      caseName: "cloudAgentsError",
      load: async () => ({
        cloudAgentsError: "Something went wrong. Try again.",
        cloudAgents: [{ agentId: "agent_elm", name: "Elm", canMessage: true }],
      }),
      expected: null,
    },
  ])("handles $caseName", async ({ load, expected }) => {
    expect(await loadDoneAgent(load)).toEqual(expected);
  });
});
