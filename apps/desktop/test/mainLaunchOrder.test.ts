import ts from "typescript";
import { describe, expect, it } from "vitest";
import { mainSource } from "./mainSource.js";

/** What launch runs: the statements of `app.whenReady().then(async () => { … })`. */
const launch = (() => {
  for (const node of mainSource.statements) {
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) continue;
    const fn = node.expression.arguments[0];
    if (node.expression.expression.getText(mainSource) === "app.whenReady().then" && fn
      && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isBlock(fn.body)) return [...fn.body.statements];
  }
  throw new Error("main.ts has no app.whenReady().then(...)");
})();

describe("launch", () => {
  it("reads no settings before the credential codec is installed", () => {
    // Without the codec the stored login reads as unreadable: the loader signs
    // the owner out and queues that login for revocation.
    const codec = launch.findIndex((s) => s.getText(mainSource).startsWith("useCredentialCodec("));
    expect(codec).toBeGreaterThan(-1);
    const early = launch.slice(0, codec).map((s) => s.getText(mainSource)).filter((text) => text.includes("loadSettings("));
    expect(early).toEqual([]);
  });
});
