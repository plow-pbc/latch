/**
 * Which credentials the screen lists as MCP clients, and what it says about
 * each. prod returns a null `agent_uid` while no assistants are live — so the
 * branch that matters is the one everyday testing never enters.
 */
import { describe, expect, it } from "vitest";
import { mcpClientRoster } from "../src/rosterSections.js";
import type { KeyInfo } from "../src/plowApi.js";
import { keyInfo, keyPrefixOf } from "./keyInfo.js";

/**
 * Fixtures go through `keyPrefixOf` rather than spelling a prefix out: plow
 * publishes `token[5:13]`, and a hand-written prefix with the scheme on the
 * front once made a matcher look correct in tests that could never match in
 * production.
 */
const key = (overrides: Partial<KeyInfo> = {}): KeyInfo =>
  keyInfo({ key_prefix: keyPrefixOf("plow_sk_other_credential_entirely"), ...overrides });

describe("which credentials are listed", () => {
  it.each([
    ["an MCP client", {}, true],
    ["a local agent's credential", { agent_uid: "local" }, false],
    ["a cloud agent's credential", { agent_uid: "cloud" }, false],
    ["a revoked client", { is_active: false }, false],
    ["a web login", { scopes: ["relay:*"] }, false],
    ["a full-access session", { scopes: ["*:*"] }, false],
    ["an old device credential", { scopes: ["relay:device"] }, false],
    ["a credential with no relay reach", { scopes: ["vault:read"] }, false],
    ["a credential with no scopes", { scopes: [] }, false],
  ])("%s: %s", (_shape, overrides, listed) => {
    expect(mcpClientRoster([key({ id: 1, ...overrides })]).map((row) => row.id)).toEqual(listed ? [1] : []);
  });

  it("never hands the renderer a prefix or a scope", () => {
    const rows = mcpClientRoster([key({ scopes: ["relay:call", "*:*", "vault:read"] })]);

    // The projection is the boundary: a screen that cannot see the grammar
    // cannot get the grammar wrong, and cannot show it either.
    expect(JSON.stringify(rows)).not.toMatch(/key_prefix|scopes|relay:call|\*:\*|vault:read|tokens_used/);
  });
});

describe("what a credential may actually do", () => {
  // Every listed client holds `relay:call`; what varies is what rides with it.
  it.each([
    ["the exact grant", ["chats:use", "llm:chat"], [true, true, true]],
    ["relay only", [], [false, true, false]],
    ["chats too", ["chats:use"], [true, true, false]],
    ["inference too", ["llm:chat"], [false, true, true]],
    // plow's matcher recognises resource and global wildcards, so this must
    // too — reading only exact grants would understate a wildcard token.
    ["a resource wildcard", ["chats:*"], [true, true, false]],
    ["the global wildcard", ["*:*"], [true, true, true]],
    // A neighbouring scope is not this one.
    ["an unrelated scope", ["vault:read", "chats:write"], [false, true, false]],
  ])("reads %s", (_shape, extra, expected) => {
    const [row] = mcpClientRoster([key({ scopes: ["relay:call", ...extra] })]);

    expect([
      row.permissions.canReadAndReply,
      row.permissions.canReachMac,
      row.permissions.canSpendInference,
    ]).toEqual(expected);
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
    const [row] = mcpClientRoster([key({ chat_uids })]);

    expect(row.chatAccess).toBe(expected);
    // The uids still travel, so the screen can say how many and which.
    expect(row.chatUids).toEqual(chat_uids);
  });
});

describe("which Mac a credential is bound to", () => {
  const OUR_DEVICE = "dev_this_mac";

  it.each([
    // Our own uid wins over the name plow has for us: the owner is looking at
    // this Mac, and "mbp" would make them go and check which one that is.
    ["this Mac", { uid: OUR_DEVICE, name: "mbp" }, null, "this Mac"],
    ["another Mac by name", { uid: "dev_other", name: "mba" }, null, "mba"],
    // Bound somewhere, name unusable. Not blank — blank reads as "works from
    // any Mac", which is the opposite of the truth.
    ["another Mac with no name", { uid: "dev_other", name: null }, null, "another Mac"],
    ["no Mac at all", null, null, null],
    // Plow resolved no device row because the binding names the ACCOUNT, which
    // it accepts only through the primary Mac. Presence is the whole signal: a
    // resource naming a device would have arrived as `device`.
    ["the account alias", null, "u_account", "primary Mac"],
    // Both arrive together for a device-bound credential; the nameable one wins.
    ["a device despite an alias", { uid: "dev_other", name: "mba" }, "u_account", "mba"],
  ])("labels a credential bound to %s", (_shape, device, relay_resource_uid, expected) => {
    const [row] = mcpClientRoster([key({ device, relay_resource_uid })], { deviceUid: OUR_DEVICE });

    expect(row.deviceLabel).toBe(expected);
  });

  it("names no Mac before this one knows its own uid", () => {
    // Startup order: the roster can be read before the device identity exists.
    // Every row would otherwise compare against "" and be labelled by name —
    // including this Mac's own, which would read as somewhere else.
    const [row] = mcpClientRoster([key({ device: { uid: OUR_DEVICE, name: "mbp" } })]);

    expect(row.deviceLabel).toBe("mbp");
  });

  it("never hands the renderer a device or resource uid", () => {
    const rows = mcpClientRoster([
      key({ id: 1, device: { uid: OUR_DEVICE, name: "mbp" } }),
      key({ id: 2, device: { uid: "dev_other_secret", name: "mba" } }),
      // A resource uid is no more renderable than a device uid: it identifies
      // something on the account, and only the label it projects may cross.
      key({ id: 3, device: null, relay_resource_uid: "u_account_secret" }),
    ], { deviceUid: OUR_DEVICE });

    expect(JSON.stringify(rows))
      .not.toMatch(/dev_this_mac|dev_other_secret|u_account_secret/);
  });
});

describe("ordering", () => {
  it("normalizes Plow's offsetless timestamps as UTC before exposing a row", () => {
    const [row] = mcpClientRoster([key({
      created_at: "2026-08-30T21:59:02.464862",
      last_seen_at: "2026-08-30T21:59:02.464862",
    })]);

    expect(row).toMatchObject({
      createdAt: "2026-08-30T21:59:02.464Z",
      lastSeenAt: "2026-08-30T21:59:02.464Z",
    });
  });

  it("puts the most recently used first and the never-used last", () => {
    const rows = mcpClientRoster([
      key({ id: 1, last_seen_at: "2026-08-20T10:00:00Z" }),
      key({ id: 2, last_seen_at: null, created_at: "2026-08-24T10:00:00Z" }),
      key({ id: 3, last_seen_at: "2026-08-25T10:00:00Z" }),
      key({ id: 4, last_seen_at: null, created_at: "2026-08-25T10:00:00Z" }),
    ]);

    // Never-used is not "oldest": it is unknown, and sorting it among real
    // timestamps would rank a client made this morning above one used a
    // minute ago.
    expect(rows.map((row) => row.id)).toEqual([3, 1, 4, 2]);
  });
});
