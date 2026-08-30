/**
 * The classification decides which removal call a row gets, and prod returns a
 * null `agent_id` while no agents are live — so the branch that matters is the
 * one everyday testing never enters.
 */
import { describe, expect, it } from "vitest";
import {
  removalRouteFor,
  sectionRoster,
  shouldAutoRevokeSession,
} from "../src/rosterSections.js";
import type { KeyInfo } from "../src/plowApi.js";

/** A device credential of the shape plow issues. */
const DEVICE_CREDENTIAL = "plow_sk_abc123_and_the_rest_of_it";

/**
 * What plow publishes as `key_prefix`: `token[5:13]`, the eight characters
 * AFTER the `plow_` scheme — the scheme itself is not in it.
 *
 * Fixtures go through here rather than spelling a prefix out. A hand-written
 * one had the scheme on the front, which made `startsWith` matching look
 * correct in tests while it could never match in production.
 */
const keyPrefixOf = (token: string) => token.slice(5, 13);

function key(overrides: Partial<KeyInfo> = {}): KeyInfo {
  return {
    id: 1,
    key_prefix: keyPrefixOf("plow_sk_other_credential_entirely"),
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

/** Every placed row, whichever section it landed in. */
const allRows = (sections: ReturnType<typeof sectionRoster>) => [
  ...sections.cloud,
  ...sections.mcp,
  ...sections.other,
];

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
      { id: 3, kind: "Admin — full access" },
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

describe("abandoned activation sessions", () => {
  const now = Date.parse("2026-08-30T12:00:00Z");
  const abandoned = (): KeyInfo => key({
    id: 2,
    name: null,
    scopes: ["*:*"],
    is_active: true,
    last_seen_at: null,
    created_at: "2026-08-30T11:49:00Z",
    agent_id: null,
  });

  it.each([
    ["the complete abandoned shape", {}, true],
    ["an inactive key", { is_active: false }, false],
    ["an agent-owned key", { agent_id: "agent_2" }, false],
    ["a narrower scope", { scopes: ["relay:*"] }, false],
    ["a named key", { name: "Another Mac" }, false],
    ["a key used once", { last_seen_at: "2026-08-30T11:50:00Z" }, false],
    ["this Mac's key", { id: 1 }, false],
    ["a key exactly ten minutes old", { created_at: "2026-08-30T11:50:00Z" }, false],
    ["a key with no creation time", { created_at: null }, false],
    ["a key with an invalid creation time", { created_at: "not-a-date" }, false],
  ] satisfies Array<[string, Partial<KeyInfo>, boolean]>)("selects %s: %s", (_case, overrides, expected) => {
    expect(shouldAutoRevokeSession({ ...abandoned(), ...overrides }, { thisMacId: 1, now }))
      .toBe(expected);
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

describe("what a credential may actually do", () => {
  it.each([
    ["the exact grant", ["chats:use", "relay:call", "llm:chat"], [true, true, true]],
    ["nothing at all", [], [false, false, false]],
    ["chats only", ["chats:use"], [true, false, false]],
    ["relay only", ["relay:call"], [false, true, false]],
    ["inference only", ["llm:chat"], [false, false, true]],
    // plow's matcher recognises resource and global wildcards, so this must
    // too — reading only exact grants would understate a wildcard token.
    ["a resource wildcard", ["relay:*"], [false, true, false]],
    ["the global wildcard", ["*:*"], [true, true, true]],
    // A neighbouring scope is not this one.
    ["an unrelated scope", ["vault:read", "chats:write"], [false, false, false]],
  ])("reads %s", (_shape, scopes, expected) => {
    const [row] = allRows(sectionRoster([key({ scopes })]));

    expect([
      row.permissions.canReadAndReply,
      row.permissions.canReachMac,
      row.permissions.canSpendInference,
    ]).toEqual(expected);
  });

  it("never hands the renderer the scopes themselves", () => {
    const sections = sectionRoster([key({ scopes: ["*:*", "vault:read"] })]);

    // The projection is the boundary: a screen that cannot see the grammar
    // cannot get the grammar wrong, and cannot show it either.
    const marshalled = JSON.stringify(sections);
    expect(marshalled).not.toContain("*:*");
    expect(marshalled).not.toContain("vault:read");
    expect(marshalled).not.toContain("scopes");
  });
});

describe("which chats a credential is scoped to", () => {
  it.each([
    ["every chat", ["*"], "all"],
    // plow reads an empty list as covering NO chats (auth.py:120). Counting
    // this as "all" told the owner a credential granted nothing had everything.
    ["no chat at all", [], "none"],
    ["one chat", ["cht_1"], "listed"],
    ["several", ["cht_1", "cht_2"], "listed"],
  ])("calls %s %s", (_shape, chat_uids, expected) => {
    const [row] = allRows(sectionRoster([key({ chat_uids })]));

    expect(row.chatAccess).toBe(expected);
    // The uids still travel, so the screen can say how many and which.
    expect(row.chatUids).toEqual(chat_uids);
  });
});

describe("this Mac's own credential", () => {
  it("is marked, so the screen can say what revoking it does", () => {
    const sections = sectionRoster(
      [
        key({ id: 1, key_prefix: keyPrefixOf(DEVICE_CREDENTIAL) }),
        key({ id: 2, key_prefix: keyPrefixOf("plow_sk_zzz999_someone_elses") }),
      ],
      { deviceCredential: DEVICE_CREDENTIAL },
    );

    // Searched across sections: this Mac's row is a Session, so it sits with
    // the other sessions rather than among the MCP clients.
    const rows = [...sections.mcp, ...sections.other];
    expect(rows.find((row) => row.id === 1)?.isThisMac).toBe(true);
    expect(rows.find((row) => row.id === 2)?.isThisMac).toBe(false);
  });

  it("is a Session, not an Admin credential, whatever its scopes read", () => {
    // This Mac holds the login session now — `*:*`, which is exactly the shape
    // `rosterKind` calls "Admin — full access". The screen must still identify
    // the credential it is running on as its own session.
    const sections = sectionRoster(
      [
        key({ id: 1, scopes: ["*:*"], key_prefix: keyPrefixOf(DEVICE_CREDENTIAL) }),
        key({ id: 2, scopes: ["*:*"], key_prefix: keyPrefixOf("plow_sk_zzz999_someone_elses") }),
      ],
      { deviceCredential: DEVICE_CREDENTIAL },
    );

    const rows = [...sections.mcp, ...sections.other];
    expect(rows.find((row) => row.id === 1)).toMatchObject({ kind: "Session", isThisMac: true });
    // Another account credential with the same scopes is still full access.
    expect(rows.find((row) => row.id === 2)).toMatchObject({ kind: "Admin — full access" });
  });

  it("marks nothing when two rows would both match", () => {
    const prefix = keyPrefixOf(DEVICE_CREDENTIAL);
    const sections = sectionRoster([key({ id: 1, key_prefix: prefix }), key({ id: 2, key_prefix: prefix })], {
      deviceCredential: DEVICE_CREDENTIAL,
    });

    // Two matches means the match identifies nothing. Warning about revoking a
    // credential that is not this Mac's is worse than not warning.
    expect(sections.mcp.every((row) => !row.isThisMac)).toBe(true);
  });

  /**
   * The shapes a prefix is not.
   *
   * Kept even though plow's contract is fixed, because the first two are what
   * produced the bug: a hand-written prefix WITH the scheme on it matched
   * `startsWith` in a fixture and could never match in production. Dropping
   * these because the server will not send them is the assumption that cost
   * this a release.
   */
  it.each([
    ["absent", null],
    ["the whole token", "plow_sk_abc123_and_the_rest_of_it"],
    ["the scheme included", "plow_sk_"],
    ["too short", "sk_abc"],
    ["too long", "sk_abc123456"],
  ])("marks nothing when the prefix is %s", (_shape, key_prefix) => {
    const sections = sectionRoster([key({ id: 1, key_prefix })], {
      deviceCredential: DEVICE_CREDENTIAL,
    });

    // Anything but the eight characters plow publishes is not a prefix from
    // plow, and guessing at a partial match would warn about the wrong row.
    expect(sections.mcp[0].isThisMac).toBe(false);
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
