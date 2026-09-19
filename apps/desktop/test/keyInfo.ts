/**
 * The wire shape `GET /v1/api-keys` answers with, in one place.
 *
 * Three fixtures encoded these defaults separately, so a field added to
 * `KeyInfo` had to be added three times — the drift surface the
 * `agent_id` → `agent_uid`/`agent_provider` rename walked into.
 */
import type { KeyInfo } from "../src/plowApi.js";

export { keyPrefixOf } from "../src/plowApi.js";

export const keyInfo = (overrides: Partial<KeyInfo> = {}): KeyInfo => ({
  id: 1,
  key_prefix: null,
  name: "Kitchen agent",
  scopes: ["relay:call"],
  tokens_used: 0,
  is_active: true,
  last_seen_at: "2026-08-25T10:00:00Z",
  created_at: "2026-08-20T10:00:00Z",
  agent_uid: null,
  chat_uids: [],
  device: null,
  relay_resource_uid: null,
  ...overrides,
});
