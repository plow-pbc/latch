import fs from "node:fs";
import ts from "typescript";

/** The shipping main.ts, parsed once so a test can run its functions without booting Electron. */
export const mainSource = ts.createSourceFile("main.ts", fs.readFileSync(
  new URL("../src/main.ts", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true);

export const mainFunctions = (...names: string[]) => mainSource.statements.filter((node) =>
  ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""));

/** The `ipcMain.handle(channel, …)` registration. */
export const mainHandler = (channel: string) => mainSource.statements.find((node) =>
  ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(mainSource) === "ipcMain.handle"
  && ts.isStringLiteral(node.expression.arguments[0])
  && node.expression.arguments[0].text === channel,
)!;

/** Plain JS for `vm.runInNewContext`. */
export const compileMain = (...nodes: ts.Node[]) =>
  ts.transpileModule(nodes.map((node) => node.getText(mainSource)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
