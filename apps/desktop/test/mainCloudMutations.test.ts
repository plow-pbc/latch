import fs from "node:fs";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

// Exercise the registered handlers and their returned snapshot without booting Electron.
const source = ts.createSourceFile("main.ts", fs.readFileSync(
  new URL("../src/main.ts", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true);
const snapshot = source.statements.find((node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === "agentsTabState",
)!;

it.each([
  ["cloud:create", "create"],
  ["cloud:changeLine", "move"],
  ["cloud:retryLineFlow", "create"],
  ["cloud:retryLineFlow", "move"],
  ["cloud:retryFailed", "create"],
] as const)("%s returns current free lines after %s", async (channel, action) => {
  const registration = source.statements.find((node) =>
    ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === "ipcMain.handle"
    && ts.isStringLiteral(node.expression.arguments[0])
    && node.expression.arguments[0].text === channel,
  )!;
  const compiled = ts.transpileModule(
    `${snapshot.getText(source)}\n${registration.getText(source)}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
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
    agentToken: null,
    requireAgentTokenSaved: () => {},
    cloudAgents: {
      create: mutate, changeLine: mutate, retryLineFlow: mutate, retryFailed: mutate,
      refresh: async () => { await setImmediate(); cachedLines = lines; },
      state: () => ({ cloudFreeLines: cachedLines.filter((line) => line.agentUid === null) }),
    },
    connectClient: {
      createCredential: mutate,
      refreshRoster: async () => { throw new Error("Agent mutation must not refresh independent sessions"); },
      state: () => ({}),
    },
  });
  const input = channel === "cloud:retryFailed" ? "agent"
    : { name: "Agent", provider: "local", agentId: "agent-old", lineUid: "line-new" };
  const result = await handler({}, input, "line-new");
  expect(result.cloudFreeLines.map((line) => line.uid)).toEqual(action === "move" ? ["line-old"] : []);
});

it("connect:create refreshes the roster, so the new credential is listed and revocable", async () => {
  const registration = source.statements.find((node) =>
    ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === "ipcMain.handle"
    && ts.isStringLiteral(node.expression.arguments[0])
    && node.expression.arguments[0].text === "connect:create",
  )!;
  const compiled = ts.transpileModule(
    `${snapshot.getText(source)}\n${registration.getText(source)}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;

  // Refreshing the cloud agents instead left the new row off the screen — and
  // with it the Remove that revokes it — until something else re-read.
  const called: string[] = [];
  let handler!: (...args: unknown[]) => Promise<{ roster: unknown }>;
  vm.runInNewContext(compiled, {
    ipcMain: { handle: (_channel: string, fn: typeof handler) => { handler = fn; } },
    agentToken: null,
    requireAgentTokenSaved: () => {},
    cloudAgents: {
      refresh: async () => { throw new Error("A mint must not re-read the cloud agents"); },
      state: () => ({ cloudFreeLines: [] }),
    },
    connectClient: {
      createCredential: async () => { called.push("createCredential"); },
      refreshRoster: async () => { called.push("refreshRoster"); },
      state: () => ({ roster: { mcp: [{ id: 41 }], other: [], revokedHidden: 0 } }),
    },
  });

  const result = await handler({}, "Claude Code");
  // In that order, or the re-read misses the credential it is there for.
  expect(called).toEqual(["createCredential", "refreshRoster"]);
  expect(result.roster).toEqual({ mcp: [{ id: 41 }], other: [], revokedHidden: 0 });
});
