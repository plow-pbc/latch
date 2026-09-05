/**
 * The wire shape `GET /v1/api-keys` answers with, in one place.
 *
 * Three fixtures encoded these defaults separately, so a field added to
 * `KeyInfo` had to be added three times — the drift surface the
 * `agent_id` → `assistant_uid`/`assistant_provider` rename walked into.
 */
import type { KeyInfo } from "../src/plowApi.js";

/** Plow publishes `token[5:13]` as the row's `key_prefix` (its `api/plow/auth.py`). */
export const keyPrefixOf = (token: string) => token.slice(5, 13);

export const keyInfo = (overrides: Partial<KeyInfo> = {}): KeyInfo => ({
  id: 1,
  key_prefix: null,
  name: "Kitchen agent",
  scopes: ["relay:call"],
  tokens_used: 0,
  is_active: true,
  last_seen_at: "2026-08-25T10:00:00Z",
  created_at: "2026-08-20T10:00:00Z",
  assistant_uid: null,
  assistant_provider: null,
  chat_uids: [],
  ...overrides,
});
