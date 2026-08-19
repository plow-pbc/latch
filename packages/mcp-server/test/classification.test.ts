/**
 * Every tool is classified, and the classification is load-bearing.
 *
 * The relay abandons an exchange on a deadline this Mac does not control. Two
 * answers fit inside it: hand back a handle and keep working (`deferrable`), or
 * finish within a hard ceiling (`direct_bounded`). A tool that can open an
 * approval prompt must be the first — a human is not a bounded wait — and a
 * tool that is the second must not be able to block past the ceiling.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceAgent, HeadlessPolicy } from "@domo/device-core";
import {
  bounded,
  createDomoMcpServer,
  CALL_BUDGET_MS,
  DIRECT_CEILING_MS,
  TOOLS,
} from "@domo/mcp-server";
import { callTool } from "./client.js";

const AGENT = { agent_id: "agent-1", agent_name: "Agent One" };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-class-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * The classification of every tool, frozen.
 *
 * A new tool fails this until someone writes down which side of the deadline it
 * answers on — which is the point: the wrong default is silent until an agent
 * is already waiting on an exchange the relay has abandoned.
 */
const CLASSIFIED: Record<string, "deferrable" | "direct_bounded"> = {
  read_file: "deferrable",
  write_file: "deferrable",
  run_command: "deferrable",
  use_tool: "deferrable",
  browser_open: "deferrable",
  browser_request: "deferrable",
  get_output: "direct_bounded",
  list_tools: "direct_bounded",
  read_skill: "direct_bounded",
  browser: "direct_bounded",
  vault: "direct_bounded",
  browser_close: "direct_bounded",
  get_result: "direct_bounded",
};

describe("tool classification", () => {
  it("classifies every tool, and only the tools that exist", () => {
    const actual = Object.fromEntries(TOOLS.map((t) => [t.name, t.classification]));
    expect(actual).toEqual(CLASSIFIED);
  });

  it("makes every tool that can open an approval prompt deferrable", () => {
    // `decideAndRun` is the single door to policy → approval → sandbox, so a
    // tool that calls it is a tool that can block on a human. Read from the
    // source because that is where the coupling actually is: a tool added with
    // an approval and no deferral would pass any check made of the exports.
    const src = fs.readFileSync(
      fileURLToPath(new URL("../src/tools.ts", import.meta.url)),
      "utf8",
    );
    // Split the TOOLS array into one chunk per spec, each starting at its name.
    const chunks = src.split(/\n  \{\n    name: "/).slice(1);
    expect(chunks.length).toBe(TOOLS.length);

    const asksAHuman = new Set<string>();
    for (const chunk of chunks) {
      const name = chunk.slice(0, chunk.indexOf('"'));
      if (chunk.includes("decideAndRun(")) asksAHuman.add(name);
    }

    expect([...asksAHuman].sort()).toEqual(
      Object.entries(CLASSIFIED)
        .filter(([, c]) => c === "deferrable")
        .map(([n]) => n)
        .sort(),
    );
  });

  it("bounds a direct tool by its own ceiling, not by the human's budget", async () => {
    // The two are different questions — how long a human may take, versus how
    // long a tool with no handle to hand back may block — and sharing one
    // number meant lengthening the first silently lengthened the second.
    const home = tempDir();
    const device = new DeviceAgent(home, "Test Mac", new HeadlessPolicy({ intent: "allow_once" }));
    const server = createDomoMcpServer(device);
    cleanups.push(() => server.close());
    expect(server.directCeilingMs()).toBe(DIRECT_CEILING_MS);

    // A long budget for the human leaves the direct ceiling where it was.
    server.setCallBudgetMs(15_000);
    expect(server.directCeilingMs()).toBe(DIRECT_CEILING_MS);

    // And it is the ceiling, not the budget, that a wedged direct tool hits.
    server.setDirectCeilingMs(40);
    device.browserCommand = () => new Promise(() => {});
    const { payload, isError } = await callTool(
      server,
      "browser",
      { session: "S1", action: "goto", url: "https://example.com/" },
      AGENT,
    );
    expect(isError).toBe(true);
    expect(String(payload.error)).toContain("40ms call ceiling");
    expect(server.callBudgetMs()).toBe(15_000);
  });

  it("holds a direct-bounded tool to the ceiling instead of blocking past it", async () => {
    const home = tempDir();
    const device = new DeviceAgent(home, "Test Mac", new HeadlessPolicy({ intent: "allow_once" }));
    // A session command that never answers — a wedged browser runtime. There is
    // no handle for the agent to come back to, so the ceiling is all that stops
    // this call outliving the relay's exchange.
    device.browserCommand = () => new Promise(() => {});
    const server = createDomoMcpServer(device, { budgetMs: 40 });
    cleanups.push(() => server.close());

    const { payload, isError } = await callTool(
      server,
      "browser",
      { session: "S1", action: "goto", url: "https://example.com/" },
      AGENT,
    );
    expect(isError).toBe(true);
    expect(String(payload.error)).toContain("40ms call ceiling");
    // Not a handle: a direct tool has nothing to hand back.
    expect(payload.status).toBeUndefined();
  });
});

describe("the direct ceiling is armed before the tool body runs", () => {
  it("schedules the timer before invoking the work, not while evaluating it", () => {
    // The bug this pins: passing the body's PROMISE meant the body was invoked
    // while evaluating the argument, so its synchronous prologue — and any I/O
    // that prologue kicked off — ran before the ceiling existed at all.
    const scheduled: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((fn: () => void, ms?: number) => {
        scheduled.push(ms ?? 0);
        return realSetTimeout(fn, ms);
      }) as typeof globalThis.setTimeout);
    try {
      let armedWhenTheBodyStarted: number[] = [];
      const work = () => {
        // Read at the top of the body — the moment a synchronous prologue runs.
        armedWhenTheBodyStarted = [...scheduled];
        return Promise.resolve("done");
      };
      const result = bounded(work, 5_000, "browser");
      expect(armedWhenTheBodyStarted).toEqual([5_000]);
      return expect(result).resolves.toBe("done");
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps a body that throws synchronously on the bounded promise", async () => {
    // With the work invoked at the call site, such a throw escaped past the
    // ceiling entirely and the tool's error mapping never saw it.
    await expect(
      bounded(() => {
        throw new Error("bad arguments");
      }, 5_000, "browser"),
    ).rejects.toThrow("bad arguments");
  });

  it("times a slow body from before it started, not from its first await", async () => {
    const started = Date.now();
    await expect(bounded(() => new Promise(() => {}), 30, "browser")).rejects.toThrow(
      "30ms call ceiling",
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("the budget the server runs deferrable tools against", () => {
  it("starts conservative and adopts what the relay's deadline allows", async () => {
    const home = tempDir();
    const device = new DeviceAgent(home, "Test Mac", new HeadlessPolicy({ intent: "allow_once" }));
    const server = createDomoMcpServer(device);
    cleanups.push(() => server.close());

    // Before any handshake this Mac assumes the old deadline.
    expect(server.callBudgetMs()).toBe(CALL_BUDGET_MS);

    server.setCallBudgetMs(15_000);
    expect(server.callBudgetMs()).toBe(15_000);

    // And the new budget is what the next call is armed with: a 30ms budget
    // must defer a call the 15s budget would have waited out.
    server.setCallBudgetMs(30);
    device.handleIntent = () => new Promise(() => {});
    const file = path.join(tempDir(), "hello.txt");
    fs.writeFileSync(file, "hello mac");
    const { payload } = await callTool(server, "read_file", { path: file }, AGENT);
    expect(payload.status).toBe("pending");
  });
});
