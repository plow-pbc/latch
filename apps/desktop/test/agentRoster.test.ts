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
    ...overrides,
  };
}

describe("agent roster rows", () => {
  it("maps each of Plow's three relay-capable scope forms to its display kind", () => {
    const rows = agentRosterRows([
      key({ id: 1, name: "Claude Code", scopes: ["relay:call"] }),
      key({ id: 2, name: "Safari login", scopes: ["relay:*"] }),
      key({ id: 3, name: null, scopes: ["*:*"] }),
    ]);

    expect(rows.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: 1, kind: "Agent" },
      { id: 2, kind: "Plow web login" },
      { id: 3, kind: "Legacy — full access" },
    ]);
  });

  it("drops inactive credentials and active credentials that cannot call the relay", () => {
    const rows = agentRosterRows([
      key({ id: 1, scopes: ["relay:call"], is_active: false }),
      key({ id: 2, scopes: ["relay:device", "llm:chat", "keys:manage"] }),
      key({ id: 3, scopes: ["files:read"] }),
      key({ id: 4, scopes: ["relay:call"] }),
    ]);

    expect(rows.map((row) => row.id)).toEqual([4]);
  });

  it("uses the most specific kind when a row has both relay:call and *:*", () => {
    const rows = agentRosterRows([key({ id: 7, scopes: ["*:*", "relay:call"] })]);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("Agent");
  });

  it("projects only renderer-safe display fields", () => {
    const rows = agentRosterRows([
      key({
        id: 9,
        key_prefix: "plow_secret_prefix",
        name: "Claude Code",
        scopes: ["relay:call", "keys:manage"],
        tokens_used: 42,
        created_at: "2026-08-16T12:00:00+00:00",
        last_seen_at: "2026-08-17T12:00:00+00:00",
      }),
    ]);

    expect(rows).toEqual([
      {
        id: 9,
        name: "Claude Code",
        kind: "Agent",
        createdAt: "2026-08-16T12:00:00+00:00",
        lastSeenAt: "2026-08-17T12:00:00+00:00",
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/key_prefix|plow_secret_prefix|scopes|tokens_used/);
  });
});
