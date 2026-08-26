import type { ChatRecipients } from "./onboarding.js";

interface MessageableCloudAgent {
  agentId: string;
  recipients: ChatRecipients | null;
  status: string;
}

/** A Messages deep link for one running agent, derived only from main-owned state. */
export function cloudAgentMessagesUrl(
  agents: readonly MessageableCloudAgent[],
  agentId: string,
): string | null {
  const agent = agents.find((candidate) => candidate.agentId === agentId);
  if (agent?.status !== "running") return null;

  const recipients = [agent.recipients?.line ?? "", ...(agent.recipients?.members ?? [])]
    .map((recipient) => recipient.trim())
    .filter((recipient, index, all) => Boolean(recipient) && all.indexOf(recipient) === index);
  return recipients.length ? `sms:${recipients.join(",")}` : null;
}
