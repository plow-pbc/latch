/** Pick the first agent the existing cloud bridge says Messages can open. */
export const HELLO_WORLD_DEMO = "Use Latch to say \"hello world\" out loud on my Mac.";

export async function loadDoneAgent(loadAgents) {
  const cloud = await loadAgents();
  if (!cloud || cloud.cloudAgentsError) return null;
  return cloud.cloudAgents.find((agent) => agent.canMessage) ?? null;
}
