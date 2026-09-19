import { describe, expect, it } from "vitest";
import { AGENT_INDEX_URL, fetchAgentIndex, parseAgentIndex } from "../src/agentIndex.js";
import { deployCards } from "../src/cloudAgentViewModel.js";

const LOGO_URL = `${new URL(AGENT_INDEX_URL).origin}/v1/agent-logos/life.png`;
const LIFE = {
  agent_id: "life", name: "Life Assistant", blurb: " Runs a household. ",
  deployable_at: "2026-09-10T16:42:29.070Z", blessed_at: "2026-09-08T00:00:00.000Z", users: 16, install_success: 88,
  builder: { name: "Sam", photo: null }, logo: LOGO_URL,
};
const LIFE_ENTRY = { blurb: "Runs a household.", builder: "Sam", users: 16, successRate: 88, verified: true, rank: 0, logoUrl: LOGO_URL };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** The Index at AGENT_INDEX_URL, and each logo URL answered by `logos`. Records every URL asked for. */
function fakeIndex(agents: unknown[], logos: Record<string, () => Response>) {
  const seen: { url: string; headers: Headers }[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) });
    if (String(url) === AGENT_INDEX_URL) return new Response(JSON.stringify({ agents }), { status: 200 });
    const logo = logos[String(url)];
    if (!logo) throw new Error(`unexpected fetch ${String(url)}`);
    return logo();
  };
  return { fetchImpl, seen };
}

describe("parseAgentIndex", () => {
  it.each([
    ["a deployable entry, under its Plow provider id", [LIFE], { "exe:life": LIFE_ENTRY }],
    // Verified is the Index's blessing; rank is its place in the list the Index sends, which is its ranking.
    ["an unverified entry, ranked where the Index lists it", [{ ...LIFE, agent_id: "b", blessed_at: null }, LIFE], {
      "exe:b": { ...LIFE_ENTRY, verified: false, rank: 0 }, "exe:life": { ...LIFE_ENTRY, rank: 1 },
    }],
    // The Index's own `hermes` is someone else's agent and is not deployable.
    ["an entry the Index does not mark deployable", [{ ...LIFE, agent_id: "hermes", deployable_at: "" }], {}],
    ["a malformed entry, dropped without the others", [null, 7, { name: "no id" }, LIFE], { "exe:life": { ...LIFE_ENTRY, rank: 3 } }],
    ["wrong field types, each nulled or zeroed", [{
      agent_id: "odd", deployable_at: "2026-09-10", blurb: 5, builder: "Sam", users: "16", install_success: "88", logo: 7, blessed_at: 5,
    }], { "exe:odd": { blurb: null, builder: null, users: 0, successRate: null, verified: false, rank: 0, logoUrl: null } }],
    // The Index names the URL; this Mac fetches only from the Index's own host.
    ["a logo hosted anywhere but the Index, dropped", [{ ...LIFE, logo: "https://elsewhere.example/v1/agent-logos/life.png" }], {
      "exe:life": { ...LIFE_ENTRY, logoUrl: null },
    }],
  ] as const)("keeps %s", (_case, agents, expected) => {
    const index = parseAgentIndex({ agents });
    expect(Object.entries(index)).toEqual(Object.entries(expected));
  });


  it.each([null, [], { agents: "no" }, { data: [] }])("refuses a response with no agent list: %j", (json) => {
    expect(() => parseAgentIndex(json)).toThrow("Agent Index returned no agent list");
  });
});

describe("fetchAgentIndex", () => {
  it("reads the public list and its logos without any credential", async () => {
    const { fetchImpl, seen } = fakeIndex([LIFE], { [LOGO_URL]: () => new Response(PNG) });
    const index = await fetchAgentIndex(fetchImpl);
    expect(seen.map(({ url }) => url)).toEqual([AGENT_INDEX_URL, LOGO_URL]);
    expect(seen.some(({ headers }) => headers.has("authorization"))).toBe(false);
    expect(index["exe:life"]?.users).toBe(16);
  });

  it("describes the provider Plow lists for an Index row, logo included, each in its real id format", async () => {
    const logoUrl = `${LOGO_URL}?card`;
    const { fetchImpl } = fakeIndex([{ ...LIFE, logo: logoUrl }], { [logoUrl]: () => new Response(PNG) });
    const [card] = deployCards([{ id: "exe:life", name: "Life Assistant", phrase: "Start Life" }], await fetchAgentIndex(fetchImpl));
    expect(card).toMatchObject({
      blurb: "Runs a household.",
      byline: "by Sam · 16 people · 88% set up",
      logo: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
    });
  });

  // The renderer loads no remote content, so a logo reaches it as bytes this
  // Mac checked; anything else leaves the card its initial.
  it.each([
    ["not a PNG", () => new Response("<svg/>")],
    ["over the size cap", () => new Response(Uint8Array.from([...PNG, ...new Uint8Array(512 * 1024)]))],
    ["a non-OK answer", () => new Response(PNG, { status: 404 })],
    ["a failed request", () => { throw new Error("offline"); }],
  ] as const)("drops a logo that is %s, keeping the entry", async (label, answer) => {
    const logoUrl = `${LOGO_URL}?${encodeURIComponent(label)}`;
    const { fetchImpl } = fakeIndex([{ ...LIFE, logo: logoUrl }], { [logoUrl]: answer });
    const index = await fetchAgentIndex(fetchImpl);
    expect(index["exe:life"]).toMatchObject({ users: 16, logo: null });
  });

  it("fetches a logo once a run, and retries one that failed", async () => {
    const logoUrl = `${LOGO_URL}?once`;
    const answers = [() => new Response("", { status: 503 }), () => new Response(PNG), () => new Response(PNG)];
    const { fetchImpl, seen } = fakeIndex([{ ...LIFE, logo: logoUrl }], { [logoUrl]: () => answers.shift()!() });
    const logos = [];
    for (let read = 0; read < 3; read++) logos.push((await fetchAgentIndex(fetchImpl))["exe:life"]?.logo);
    expect(logos.map((logo) => logo?.slice(0, 22) ?? null)).toEqual([null, "data:image/png;base64,", "data:image/png;base64,"]);
    expect(seen.filter(({ url }) => url === logoUrl)).toHaveLength(2);
  });

  it("never fetches a logo the Index hosts elsewhere", async () => {
    const { fetchImpl, seen } = fakeIndex([{ ...LIFE, logo: "https://elsewhere.example/life.png" }], {});
    const index = await fetchAgentIndex(fetchImpl);
    expect(seen.map(({ url }) => url)).toEqual([AGENT_INDEX_URL]);
    expect(index["exe:life"]?.logo).toBeNull();
  });

  it("fails loudly on a non-OK answer", async () => {
    await expect(fetchAgentIndex(async () => new Response("", { status: 503 })))
      .rejects.toThrow("Agent Index returned 503");
  });
});
