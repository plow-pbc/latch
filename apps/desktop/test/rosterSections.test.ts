/**
 * The classification decides which removal call a row gets, and prod returns a
 * null `agent_id` while no agents are live — so the branch that matters is the
 * one everyday testing never enters.
 */
import { describe, expect, it } from "vitest";
import { sectionRoster, removalRouteFor } from "../src/rosterSections.js";
import type { KeyInfo } from "../src/plowApi.js";

function key(overrides: Partial<KeyInfo> = {}): KeyInfo {
  return {
    id: 1,
    key_prefix: "plow_sk_abc123",
    name: "Kitchen agent",
    scopes: ["relay:call"],
    tokens_used: 0,
    is_active: true,
    last_seen_at: "2026-08-25T10:00:00Z",
    created_at: "2026-08-20T10:00:00Z",
    agent_id: null,
    chat_uids: [],
    ...overrides,
  };
}

describe("which section a credential belongs in", () => {
  it("puts a credential with an agent_id in Cloud agents, whatever its scopes", () => {
    const sections = sectionRoster([
      key({ id: 1, agent_id: "agent_1" }),
      key({ id: 2, agent_id: "agent_2", scopes: ["relay:*"] }),
    ]);

    expect(sections.cloud.map((row) => row.id)).toEqual([1, 2]);
    expect(sections.mcp).toEqual([]);
    expect(sections.other).toEqual([]);
  });

  it("separates MCP clients from other sessions by scope", () => {
    const sections = sectionRoster([
      key({ id: 1, scopes: ["relay:call"] }),
      key({ id: 2, scopes: ["relay:*"] }),
      key({ id: 3, scopes: ["*:*"] }),
    ]);

    expect(sections.mcp.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: 1, kind: "Agent" },
    ]);
    expect(sections.other.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: 2, kind: "Plow web login" },
      { id: 3, kind: "Legacy — full access" },
    ]);
  });

  it("counts revoked credentials rather than listing them", () => {
    const sections = sectionRoster([
      key({ id: 1 }),
      key({ id: 2, is_active: false }),
      key({ id: 3, is_active: false, agent_id: "agent_3" }),
    ]);

    expect(sections.revokedHidden).toBe(2);
    expect([...sections.cloud, ...sections.mcp, ...sections.other].map((r) => r.id)).toEqual([1]);
  });

  it("places every row it is given, whatever kind it turns out to be", () => {
    const keys = [
      key({ id: 1, agent_id: "agent_1" }),
      key({ id: 2, scopes: ["relay:call"] }),
      key({ id: 3, scopes: ["relay:*"] }),
      key({ id: 4, scopes: ["vault:read"] }),
      key({ id: 5, scopes: [] }),
    ];
    const sections = sectionRoster(keys);

    const placed = [...sections.cloud, ...sections.mcp, ...sections.other].map((row) => row.id);
    expect(placed.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(placed).size).toBe(placed.length);
    expect(sections.other.filter((row) => [4, 5].includes(row.id)).map((row) => row.kind)).toEqual([
      "Session",
      "Session",
    ]);
    expect(JSON.stringify(sections)).not.toMatch(
      /key_prefix|plow_sk_abc123|scopes|relay:call|tokens_used/,
    );
  });
});

describe("how a row is removed", () => {
  it("never routes a credential with an agent_id to the key revoke", () => {
    // The negative, because the key revoke flips `is_active` and nothing else:
    // the VM keeps running, the chat's webhook keeps firing, and the row
    // vanishes from the list because inactive rows are filtered out. A live
    // agent that 401s on everything and nobody can reach to remove.
    const sections = sectionRoster([
      key({ id: 1, agent_id: "agent_1" }),
      key({ id: 2, agent_id: "agent_2", scopes: ["*:*"] }),
      key({ id: 3, agent_id: "agent_3", scopes: ["relay:*"], name: null }),
    ]);

    // The section IS the route: `connectClient.removeRosterRow` reads
    // `agentId` off the row it finds here, so a row in the wrong section is a
    // removal down the wrong path. Asserted through the real removal in
    // connectClient.test.ts; what this pins is the placement it depends on.
    expect(sections.cloud).toHaveLength(3);
    for (const row of sections.cloud) expect(row.agentId).not.toBeNull();
    for (const row of [...sections.mcp, ...sections.other]) expect(row.agentId).toBeNull();
  });
});

describe("this Mac's own credential", () => {
  it("is marked, so the screen can say what revoking it does", () => {
    const sections = sectionRoster(
      [key({ id: 1, key_prefix: "plow_sk_abc123" }), key({ id: 2, key_prefix: "plow_sk_zzz999" })],
      { deviceCredential: "plow_sk_abc123_and_the_rest_of_it" },
    );

    expect(sections.mcp.find((row) => row.id === 1)?.isThisMac).toBe(true);
    expect(sections.mcp.find((row) => row.id === 2)?.isThisMac).toBe(false);
  });

  it("marks nothing when two rows would both match", () => {
    const sections = sectionRoster(
      [key({ id: 1, key_prefix: "plow_sk_abc123" }), key({ id: 2, key_prefix: "plow_sk_abc123" })],
      { deviceCredential: "plow_sk_abc123_and_the_rest_of_it" },
    );

    // Two matches means the match identifies nothing. Warning about revoking a
    // credential that is not this Mac's is worse than not warning.
    expect(sections.mcp.every((row) => !row.isThisMac)).toBe(true);
  });

  it("marks nothing when the prefix is absent or too short to mean anything", () => {
    const sections = sectionRoster(
      [key({ id: 1, key_prefix: null }), key({ id: 2, key_prefix: "plow" })],
      { deviceCredential: "plow_sk_abc123_and_the_rest_of_it" },
    );

    // A short prefix would match half the account. Better to mark nothing than
    // to warn about the wrong row.
    expect(sections.mcp.every((row) => !row.isThisMac)).toBe(true);
  });
});

describe("ordering", () => {
  it("puts the most recently used first and the never-used last", () => {
    const sections = sectionRoster([
      key({ id: 1, last_seen_at: "2026-08-20T10:00:00Z" }),
      key({ id: 2, last_seen_at: null, created_at: "2026-08-24T10:00:00Z" }),
      key({ id: 3, last_seen_at: "2026-08-25T10:00:00Z" }),
      key({ id: 4, last_seen_at: null, created_at: "2026-08-25T10:00:00Z" }),
    ]);

    // Never-used is not "oldest": it is unknown, and sorting it among real
    // timestamps would rank a client made this morning above one used a
    // minute ago.
    expect(sections.mcp.map((row) => row.id)).toEqual([3, 1, 4, 2]);
  });
});
