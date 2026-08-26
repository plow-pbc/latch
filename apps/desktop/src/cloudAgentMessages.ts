interface MessageableCloudAgent {
  agentId: string;
  chatLabel: string;
  status: string;
}

/** A Messages deep link for one running agent, derived only from main-owned state. */
export function cloudAgentMessagesUrl(
  agents: readonly MessageableCloudAgent[],
  agentId: string,
): string | null {
  const agent = agents.find((candidate) => candidate.agentId === agentId);
  if (agent?.status !== "running") return null;

  const recipients = [...agent.chatLabel.matchAll(/\+\d[\d ().-]*\d/g)]
    .map(([phone]) => `+${phone.slice(1).replace(/\D/g, "")}`)
    .filter((phone, index, all) => /^\+\d{7,15}$/.test(phone) && all.indexOf(phone) === index);
  return recipients.length ? `sms:${recipients.join(",")}` : null;
}
