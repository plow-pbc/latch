/** Pick the first agent the existing cloud bridge says Messages can open. */
export async function loadDoneAgent(loadAgents) {
  const cloud = await loadAgents();
  if (!cloud || cloud.cloudAgentsError) return null;
  return cloud.cloudAgents.find((agent) => agent.canMessage) ?? null;
}
