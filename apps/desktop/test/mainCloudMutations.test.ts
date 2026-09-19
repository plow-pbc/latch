import { setImmediate } from "node:timers/promises";
import vm from "node:vm";
import { expect, it } from "vitest";
import { compileMain, mainFunctions, mainHandler } from "./mainSource.js";

// Exercise the registered handlers and their returned snapshot without booting Electron.
const withSnapshot = (channel: string) => compileMain(...mainFunctions("agentsTabState"), mainHandler(channel));

it.each([
  ["cloud:changeLine", "move"],
] as const)("%s returns current free lines after %s", async (channel, action) => {
  const compiled = withSnapshot(channel);
  let lines: { uid: string; agentUid: string | null }[] = [
    { uid: "line-new", agentUid: null },
    { uid: "line-old", agentUid: "agent-old" },
  ];
  let cachedLines = lines;
  const mutate = async () => {
    await setImmediate();
    lines = [
      { uid: "line-new", agentUid: action === "move" ? "agent-old" : "agent" },
      { uid: "line-old", agentUid: action === "move" ? null : "agent-old" },
    ];
  };
  let handler!: (...args: unknown[]) => Promise<{ cloudFreeLines: { uid: string }[] }>;
  vm.runInNewContext(compiled, {
    ipcMain: { handle: (_channel: string, fn: typeof handler) => { handler = fn; } },
    cloudAgents: {
      changeLine: mutate,
      refresh: async () => { await setImmediate(); cachedLines = lines; },
      state: () => ({ cloudFreeLines: cachedLines.filter((line) => line.agentUid === null) }),
    },
    connectClient: {
      createCredential: mutate,
      refreshRoster: async () => { throw new Error("Agent mutation must not refresh independent sessions"); },
      state: () => ({}),
    },
  });
  const input = { name: "Agent", provider: "local", agentId: "agent-old", lineUid: "line-new" };
  const result = await handler({}, input, "line-new");
  expect(result.cloudFreeLines.map((line) => line.uid)).toEqual(action === "move" ? ["line-old"] : []);
});

it("connect:create refreshes the roster, so the new credential is listed and revocable", async () => {
  const compiled = withSnapshot("connect:create");

  // Refreshing the cloud agents instead left the new row off the screen — and
  // with it the Remove that revokes it — until something else re-read.
  const called: string[] = [];
  let handler!: (...args: unknown[]) => Promise<{ roster: unknown }>;
  vm.runInNewContext(compiled, {
    ipcMain: { handle: (_channel: string, fn: typeof handler) => { handler = fn; } },
    cloudAgents: {
      refresh: async () => { throw new Error("A mint must not re-read the cloud agents"); },
      state: () => ({ cloudFreeLines: [] }),
    },
    connectClient: {
      createCredential: async () => { called.push("createCredential"); },
      refreshRoster: async () => { called.push("refreshRoster"); },
      state: () => ({ roster: [{ id: 41 }] }),
    },
  });

  const result = await handler({}, "Claude Code");
  // In that order, or the re-read misses the credential it is there for.
  expect(called).toEqual(["createCredential", "refreshRoster"]);
  expect(result.roster).toEqual([{ id: 41 }]);
});
