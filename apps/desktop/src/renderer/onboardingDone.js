/** Pick the first agent the existing cloud bridge says Messages can open. */
export async function loadDoneAgent(loadAgents) {
  try {
    const cloud = await loadAgents();
    if (cloud?.cloudAgentsError) return null;
    return (cloud?.cloudAgents ?? []).find((agent) =>
      agent?.canMessage === true && typeof agent.agentId === "string" && typeof agent.name === "string"
    ) ?? null;
  } catch {
    return null;
  }
}
