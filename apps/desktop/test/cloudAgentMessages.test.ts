import { describe, expect, it } from "vitest";

import { cloudAgentMessagesUrl } from "../src/cloudAgentMessages.js";

describe("cloudAgentMessagesUrl", () => {
  const running = {
    agentId: "cag_ready",
    chatLabel: "+1 (415) 555-0142, +1 (415) 555-0193, +1 (628) 555-0112",
    status: "running",
  };

  it("opens the running agent's ordered chat numbers in Messages", () => {
    expect(cloudAgentMessagesUrl([running], running.agentId)).toBe(
      "sms:+14155550142,+14155550193,+16285550112",
    );
  });

  it("does not offer a Messages route before the agent is running", () => {
    expect(cloudAgentMessagesUrl([{ ...running, status: "provisioning" }], running.agentId)).toBeNull();
  });
});
