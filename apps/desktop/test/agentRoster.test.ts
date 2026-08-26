import { describe, expect, it } from "vitest";
import { agentRosterRows } from "../src/agentRoster.js";
import type { KeyInfo } from "../src/plowApi.js";

function key(overrides: Partial<KeyInfo>): KeyInfo {
  return {
    id: 1,
    key_prefix: "secret-prefix",
    name: "Credential",
    scopes: [],
    tokens_used: 0,
    is_active: true,
    last_seen_at: null,
    created_at: null,
    agent_id: null,
    chat_uids: ["*"],
    ...overrides,
  };
}

describe("agent roster rows", () => {
  it("returns every session with routing and status while projecting credentials away", () => {
    const rows = agentRosterRows([
      key({
        id: 9,
        key_prefix: "plow_secret_prefix",
        name: "Cloud session",
        scopes: ["relay:call", "keys:manage"],
        tokens_used: 42,
        agent_id: "agent_123",
        chat_uids: ["cht_123"],
      }),
      key({
        id: 10,
        name: "Safari login",
        scopes: ["relay:*"],
        chat_uids: ["*"],
      }),
      key({ id: 11, scopes: ["relay:call"], is_active: false }),
      key({ id: 12, scopes: ["files:read"] }),
    ]);

    expect(rows).toEqual([
      {
        id: 9,
        name: "Cloud session",
        kind: "Agent",
        createdAt: null,
        lastSeenAt: null,
        agentId: "agent_123",
        chatUids: ["cht_123"],
        isActive: true,
      },
      {
        id: 10,
        name: "Safari login",
        kind: "Plow web login",
        createdAt: null,
        lastSeenAt: null,
        agentId: null,
        chatUids: ["*"],
        isActive: true,
      },
      {
        id: 11,
        name: "Credential",
        kind: "Agent",
        createdAt: null,
        lastSeenAt: null,
        agentId: null,
        chatUids: ["*"],
        isActive: false,
      },
      {
        id: 12,
        name: "Credential",
        kind: "Session",
        createdAt: null,
        lastSeenAt: null,
        agentId: null,
        chatUids: ["*"],
        isActive: true,
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/key_prefix|plow_secret_prefix|scopes|tokens_used/);
  });
});
