import { describe, expect, it } from "vitest";
import { AGENT_INDEX_URL, fetchAgentIndex, parseAgentIndex } from "../src/agentIndex.js";
import { deployCards } from "../src/cloudAgentViewModel.js";

const LIFE = {
  agent_id: "life", name: "Life Assistant", blurb: " Runs a household. ",
  deployable_at: "2026-09-10T16:42:29.070Z", users: 16, install_success: 88,
  builder: { name: "Sam", photo: null },
};

describe("parseAgentIndex", () => {
  it.each([
    ["a deployable entry, under its Plow provider id", [LIFE], { "exe:life": { blurb: "Runs a household.", builder: "Sam", users: 16, successRate: 88 } }],
    // The Index's own `hermes` is someone else's agent and is not deployable.
    ["an entry the Index does not mark deployable", [{ ...LIFE, agent_id: "hermes", deployable_at: "" }], {}],
    ["a malformed entry, dropped without the others", [null, 7, { name: "no id" }, LIFE], {
      "exe:life": { blurb: "Runs a household.", builder: "Sam", users: 16, successRate: 88 },
    }],
    ["wrong field types, each nulled or zeroed", [{
      agent_id: "odd", deployable_at: "2026-09-10", blurb: 5, builder: "Sam", users: "16", install_success: "88",
    }], { "exe:odd": { blurb: null, builder: null, users: 0, successRate: null } }],
  ] as const)("keeps %s", (_case, agents, expected) => {
    const index = parseAgentIndex({ agents });
    expect(Object.entries(index)).toEqual(Object.entries(expected));
  });

  it("describes the provider Plow lists for an Index row, each in its real id format", () => {
    const [card] = deployCards([{ id: "exe:life", name: "Life Assistant", phrase: "Start Life" }], parseAgentIndex({ agents: [LIFE] }));
    expect(card).toMatchObject({ blurb: "Runs a household.", byline: "by Sam · 16 people · 88% set up" });
  });

  it.each([null, [], { agents: "no" }, { data: [] }])("refuses a response with no agent list: %j", (json) => {
    expect(() => parseAgentIndex(json)).toThrow("Agent Index returned no agent list");
  });
});

describe("fetchAgentIndex", () => {
  it("reads the public list without any credential", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const index = await fetchAgentIndex(async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ agents: [LIFE] }), { status: 200 });
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(AGENT_INDEX_URL);
    expect(seen[0]!.headers.has("authorization")).toBe(false);
    expect(index["exe:life"]?.users).toBe(16);
  });

  it("fails loudly on a non-OK answer", async () => {
    await expect(fetchAgentIndex(async () => new Response("", { status: 503 })))
      .rejects.toThrow("Agent Index returned 503");
  });
});
