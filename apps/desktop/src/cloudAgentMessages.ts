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
  const line = agent?.recipients?.line?.trim();
  if (agent?.status !== "running" || !line) return null;

  const recipients = [line, ...(agent.recipients?.members ?? [])]
    .map((recipient) => recipient.trim())
    .filter((recipient, index, all) => Boolean(recipient) && all.indexOf(recipient) === index);
  return recipients.length ? `sms:${recipients.join(",")}` : null;
}
