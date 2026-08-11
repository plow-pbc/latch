import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recall } from "../src/recall.js";
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

  it("rejects when ltmm emits something that is not JSON", async () => {
    process.env.DOMO_LTMM_BIN = stubLtmm("Traceback (most recent call last):");
    await expect(recall("anything")).rejects.toThrow(/JSON/i);
  });

  it("rejects when ltmm is not installed", async () => {
    process.env.DOMO_LTMM_BIN = path.join(dir, "does-not-exist");
    await expect(recall("anything")).rejects.toThrow();
  });

  it("passes the query and limit through to the CLI", async () => {
    const bin = path.join(dir, "echo-args");
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '["%s"]' "$*"\n`);
    fs.chmodSync(bin, 0o755);
    process.env.DOMO_LTMM_BIN = bin;

    const [seen] = (await recall("where does abby work", 3)) as unknown as string[];

    expect(seen).toContain("query");
    expect(seen).toContain("where does abby work");
    expect(seen).toContain("--json");
    expect(seen).toContain("3");
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

  it("rejects a call with no query rather than recalling everything", async () => {
    const tool = BlessedToolRegistry.standard().tool("recall");
    await expect(tool!.invoke({})).rejects.toThrow(/query/i);
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
