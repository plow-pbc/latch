import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LIMIT, MAX_LIMIT, recall } from "../src/recall.js";
import { BlessedToolRegistry } from "../src/blessedTools.js";
import { DeviceAgent } from "../src/deviceAgent.js";
import { HeadlessPolicy } from "../src/policyEngine.js";

let dir: string;

/** A stand-in for the ltmm CLI: emits what we give it, with an exit code. */
function stubLtmm(stdout: string, code = 0, stderr = ""): string {
  const bin = path.join(dir, "ltmm-stub");
  fs.writeFileSync(
    bin,
    `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\n>&2 cat <<'EOF'\n${stderr}\nEOF\nexit ${code}\n`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-recall-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.DOMO_LTMM_BIN;
});

describe("recall", () => {
  it("returns the facts ltmm reports", async () => {
    process.env.DOMO_LTMM_BIN = stubLtmm(
      JSON.stringify([
        {
          statement: "Abby ran the Seattle half marathon",
          type: "life-detail",
          person: "Abby",
          confidence: 1.0,
          observed: "2024-03-02",
          message_ids: [8821, 8823],
        },
      ]),
    );

    const facts = await recall("marathon");

    expect(facts).toHaveLength(1);
    expect(facts[0].statement).toBe("Abby ran the Seattle half marathon");
    expect(facts[0].message_ids).toEqual([8821, 8823]);
  });

  it("returns an empty array when nothing matches", async () => {
    // An empty result is a real answer. The agent must be able to tell
    // "the store knows nothing about this" from "the tool failed".
    process.env.DOMO_LTMM_BIN = stubLtmm("[]");
    await expect(recall("anything")).resolves.toEqual([]);
  });

  it("rejects when ltmm exits non-zero, surfacing its stderr", async () => {
    process.env.DOMO_LTMM_BIN = stubLtmm("", 1, "ltmm: no store at /nope");
    await expect(recall("anything")).rejects.toThrow(/no store/);
  });

  it.each([
    ["not JSON at all", "Traceback (most recent call last):"],
    ["valid JSON that is not an array", '{"facts": []}'],
    ["an array of things that are not fact objects", '["hello"]'],
    ["an array of nested arrays", "[[1,2]]"],
    ["fact objects with no statement", "[{}]"],
  ])("rejects when ltmm emits %s", async (_label, stdout) => {
    process.env.DOMO_LTMM_BIN = stubLtmm(stdout);
    await expect(recall("anything")).rejects.toThrow(/JSON/i);
  });

  it("rejects when ltmm is not installed", async () => {
    process.env.DOMO_LTMM_BIN = path.join(dir, "does-not-exist");
    await expect(recall("anything")).rejects.toThrow();
  });

  /** An `ltmm` that reports its own argv back as the single "fact" it found. */
  function echoArgs(): string {
    const bin = path.join(dir, "echo-args");
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '[{"statement":"%s"}]' "$*"\n`);
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  it("passes the query and limit through to the CLI", async () => {
    process.env.DOMO_LTMM_BIN = echoArgs();

    const [fact] = await recall("where does abby work", 3);

    expect(fact.statement).toContain("query");
    expect(fact.statement).toContain("where does abby work");
    expect(fact.statement).toContain("--json");
    expect(fact.statement).toContain("3");
  });

  it("applies DEFAULT_LIMIT when the caller gives none", async () => {
    process.env.DOMO_LTMM_BIN = echoArgs();
    const [fact] = await recall("anything");
    expect(fact.statement).toContain(`--limit ${DEFAULT_LIMIT}`);
  });

  it("keeps a dash-leading query a query rather than a flag", async () => {
    // `ltmm query` inherits --store/--db, so without a `--` terminator this is
    // an agent that was denied process.exec repointing a trusted subprocess.
    process.env.DOMO_LTMM_BIN = echoArgs();
    const [fact] = await recall("--store=/tmp/evil.db");
    expect(fact.statement).toContain("-- --store=/tmp/evil.db");
  });

  it.each([
    ["not a number", "3" as unknown as number],
    ["NaN", Number.NaN],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 2.5],
    ["past MAX_LIMIT", MAX_LIMIT + 1],
  ])("rejects a limit that is %s rather than coercing it", async (_label, limit) => {
    // Loud rather than silently swapped for the default: the agent supplies
    // this, and `--limit NaN` would come back as an argparse usage error
    // indistinguishable from a real store failure.
    process.env.DOMO_LTMM_BIN = echoArgs();
    await expect(recall("anything", limit)).rejects.toThrow(/limit/i);
  });
});

describe("the recall blessed tool", () => {
  it("appears in the standard manifest with a required query parameter", () => {
    const manifest = BlessedToolRegistry.standard().manifest() as Array<{
      name: string;
      description: string;
      inputSchema: { properties: Record<string, unknown>; required: string[] };
    }>;
    const tool = manifest.find((t) => t.name === "recall");

    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties).toHaveProperty("query");
    expect(tool!.inputSchema.required).toEqual(["query"]);
    // The description is the only thing the agent reads when deciding to call it.
    expect(tool!.description.length).toBeGreaterThan(40);
  });

  it("returns the store's facts through invoke", async () => {
    process.env.DOMO_LTMM_BIN = stubLtmm(
      JSON.stringify([
        {
          statement: "Abby started at Menlo Church",
          type: "work",
          person: "Abby",
          confidence: 2.1,
          observed: "2025-01-06",
          message_ids: [41],
        },
      ]),
    );

    const tool = BlessedToolRegistry.standard().tool("recall");
    const result = (await tool!.invoke({ query: "where does abby work" })) as {
      facts: Array<{ statement: string }>;
    };

    expect(result.facts[0].statement).toBe("Abby started at Menlo Church");
  });

  it.each([
    ["no query at all", {}, /query/i],
    ["a whitespace-only query", { query: "   " }, /query/i],
    // The tool used to swap any non-number for DEFAULT_LIMIT, turning an agent's
    // malformed call into a silently different one.
    ["a non-numeric limit", { query: "abby", limit: "3" }, /limit/i],
    ["a limit past the advertised maximum", { query: "abby", limit: 500 }, /limit/i],
  ])("rejects %s rather than recalling something else", async (_label, args, expected) => {
    const tool = BlessedToolRegistry.standard().tool("recall");
    await expect(tool!.invoke(args)).rejects.toThrow(expected);
  });

  it("advertises the bounds recall actually enforces", () => {
    // The schema is the only contract the agent sees, and use_tool does not
    // validate against it — an agent that obeys it and is still rejected has
    // been misled by this file.
    const tool = BlessedToolRegistry.standard().tool("recall");
    const schema = tool!.inputSchema as {
      properties: { limit: { type: string; minimum: number; maximum: number } };
    };
    expect(schema.properties.limit.type).toBe("integer");
    expect(schema.properties.limit.minimum).toBe(1);
    expect(schema.properties.limit.maximum).toBe(MAX_LIMIT);
  });

  it("is wired into a DeviceAgent's default tool set", () => {
    // The registry is only reachable by an agent if DeviceAgent defaults to it
    // (deviceAgent.ts:39). Registering in standard() without that wiring would
    // pass every test above and still be invisible over MCP.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "domo-agent-"));
    try {
      const agent = new DeviceAgent(home, "test-device", new HeadlessPolicy({ intent: "deny" }));
      expect(agent.blessedTools.tool("recall")).not.toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
