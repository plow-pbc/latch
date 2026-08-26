import { describe, expect, it } from "vitest";

import { cloudAgentMessagesUrl } from "../src/cloudAgentMessages.js";

describe("cloudAgentMessagesUrl", () => {
  const running = {
    agentId: "cag_ready",
    chatLabel: "chat_groceries",
    recipients: {
      line: "+14155550142",
      members: ["+14155550193", "+16285550112"],
    },
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

  it("does not infer recipients from a display label", () => {
    expect(cloudAgentMessagesUrl([{
      ...running,
      chatLabel: "+1 (415) 555-0142 · Household",
      recipients: null,
    }], running.agentId)).toBeNull();
  });

  it("does not message only the humans when the agent line is unknown", () => {
    expect(cloudAgentMessagesUrl([{
      ...running,
      recipients: { line: null, members: ["+14155550193", "+16285550112"] },
    }], running.agentId)).toBeNull();
  });
});
