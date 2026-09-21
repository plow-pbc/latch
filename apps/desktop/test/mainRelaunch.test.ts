import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

// Exercise the shipping handler without booting Electron.
const source = ts.createSourceFile("main.ts", fs.readFileSync(
  new URL("../src/main.ts", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true);

it("relaunches without arming anything — setup checkpoints itself", () => {
  const registration = source.statements.find((node) =>
    ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === "ipcMain.handle"
    && ts.isStringLiteral(node.expression.arguments[0])
    && node.expression.arguments[0].text === "app:relaunch",
  )!;
  const compiled = ts.transpileModule(registration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const calls: string[] = [];
  let handler!: () => void;
  vm.runInNewContext(compiled, {
    ipcMain: { handle: (_channel: string, fn: typeof handler) => { handler = fn; } },
    app: {
      relaunch: () => calls.push("relaunch"),
      quit: () => calls.push("quit"),
    },
  });

  handler();

  expect(calls).toEqual(["relaunch", "quit"]);
});
