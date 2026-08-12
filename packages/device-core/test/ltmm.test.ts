import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RECALL_FAILED, RECALL_UNREADABLE, recall, startSeeding } from "../src/ltmm.js";
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

/** An `ltmm` that reports its own argv back as the single "fact" it found. */
function echoArgs(): string {
  const bin = path.join(dir, "echo-args");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '[{"statement":"%s"}]' "$*"\n`);
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

  it.each([
    ["not JSON at all", "Traceback (most recent call last):", "Traceback"],
    ["valid JSON that is not an array", '{"facts": []}', "expected an array"],
    ["an array of things that are not fact objects", '["hello"]', "expected an array"],
    ["an array of nested arrays", "[[1,2]]", "expected an array"],
    ["fact objects with no statement", "[{}]", "expected an array"],
  ])("rejects when ltmm emits %s", async (_label, stdout, causeFragment) => {
    process.env.DOMO_LTMM_BIN = stubLtmm(stdout);

    const failure = await recall("anything").catch((e: Error) => e);

    // Same split: a stable public message, detail only in the cause. A Python
    // traceback carries absolute paths just as stderr does.
    expect(failure.message).toBe(RECALL_UNREADABLE);
    expect(String(failure.cause)).toContain(causeFragment);
  });

  it("rejects when ltmm is not installed", async () => {
    process.env.DOMO_LTMM_BIN = path.join(dir, "does-not-exist");
    await expect(recall("anything")).rejects.toThrow(RECALL_FAILED);
  });

  it("rejects an empty query rather than recalling everything", async () => {
    process.env.DOMO_LTMM_BIN = echoArgs();
    await expect(recall("   ")).rejects.toThrow(/query/i);
  });

  it("passes the query through to the CLI under a fixed cap", async () => {
    // The cap is ours, not the caller's: nothing in the argv comes from the
    // agent except the query itself, after the `--`.
    process.env.DOMO_LTMM_BIN = echoArgs();

    const [fact] = await recall("where does abby work");

    expect(fact.statement).toBe("query --json --limit 10 -- where does abby work");
  });

  it("keeps a dash-leading query a query rather than a flag", async () => {
    // `ltmm query` inherits --store/--db, so without a `--` terminator this is
    // an agent that was denied process.exec repointing a trusted subprocess.
    process.env.DOMO_LTMM_BIN = echoArgs();
    const [fact] = await recall("--store=/tmp/evil.db");
    expect(fact.statement).toContain("-- --store=/tmp/evil.db");
  });
});

describe("the recall blessed tool", () => {
  it("takes a query and nothing else", () => {
    const manifest = BlessedToolRegistry.standard().manifest() as Array<{
      name: string;
      description: string;
      inputSchema: { properties: Record<string, unknown>; required: string[] };
    }>;
    const tool = manifest.find((t) => t.name === "recall");

    expect(tool).toBeDefined();
    expect(Object.keys(tool!.inputSchema.properties)).toEqual(["query"]);
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
    ["no query at all", {}],
    ["a whitespace-only query", { query: "   " }],
  ])("rejects %s rather than recalling everything", async (_label, args) => {
    const tool = BlessedToolRegistry.standard().tool("recall");
    await expect(tool!.invoke(args)).rejects.toThrow(/query/i);
  });

  it("ignores an agent-supplied limit instead of honoring it", async () => {
    // How much of a private store one call returns is not the caller's to
    // choose, and an unknown argument is not an error worth failing on.
    process.env.DOMO_LTMM_BIN = echoArgs();

    const tool = BlessedToolRegistry.standard().tool("recall");
    const result = (await tool!.invoke({ query: "abby", limit: 500 })) as {
      facts: Array<{ statement: string }>;
    };

    expect(result.facts[0].statement).toContain("--limit 10");
    expect(result.facts[0].statement).not.toContain("500");
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

describe("startSeeding", () => {
  function seedDeps() {
    const started: Array<{ bin: string; args: string[] }> = [];
    return {
      started,
      deps: {
        startBuild: (bin: string, args: string[]) => {
          started.push({ bin, args });
        },
      },
    };
  }

  it("runs ltmm with no conversation argument, so ltmm picks the top contact", () => {
    // The exact argv is the whole point of the zero-argument bootstrap: Domo
    // must not need to know which conversation matters, and must not hardcode
    // one. It is also the whole command — no store path and no resume flag,
    // because deciding what is left to do is ltmm's job, not Domo's.
    const { started, deps } = seedDeps();
    startSeeding(deps);
    expect(started).toHaveLength(1);
    expect(started[0].args).toEqual(["run"]);
  });

  it("resolves the binary the same way recall does", () => {
    // The point of one gateway: a test harness that overrides the binary must
    // not find it honoured on the read path and missed on the seeding path.
    // `DOMO_LTMM_BIN=$(which ltmm)` on a Mac without ltmm sets an empty string,
    // and spawn("") throws ERR_INVALID_ARG_VALUE synchronously, out of the
    // app-ready handler that calls this.
    process.env.DOMO_LTMM_BIN = "";
    const { started, deps } = seedDeps();
    startSeeding(deps);
    expect(started[0].bin).toBe("ltmm");

    process.env.DOMO_LTMM_BIN = "/usr/bin/true";
    const override = seedDeps();
    startSeeding(override.deps);
    expect(override.started[0].bin).toBe("/usr/bin/true");
  });

  it("survives a missing ltmm instead of taking the app down", async () => {
    // Drives the REAL deps, because an injected stub cannot reproduce this:
    // spawn reports a missing binary asynchronously on the child's `error`
    // event, and an unlistened `error` re-throws as an uncaught exception in the
    // Electron main process. Without the listener this file fails on that
    // uncaught exception rather than on an assertion.
    process.env.DOMO_LTMM_BIN = path.join(dir, "does-not-exist");
    expect(() => startSeeding()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
