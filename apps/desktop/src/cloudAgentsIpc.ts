import type { CloudAgentsUiState } from "./cloudAgentState.js";

export type CloudAgentsPreloadState = Pick<
  CloudAgentsUiState,
  "cloudAgents" | "cloudAgentsError"
>;

interface CloudAgentsStateSource {
  refresh(): Promise<void>;
  state(): CloudAgentsUiState;
}

export async function cloudAgentsIpcResult(
  source: CloudAgentsStateSource | null,
): Promise<CloudAgentsPreloadState | null> {
  await source?.refresh();
  if (!source) return null;

  const { cloudAgents, cloudAgentsError } = source.state();
  return { cloudAgents, cloudAgentsError };
}
