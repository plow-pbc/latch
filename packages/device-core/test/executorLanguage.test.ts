import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Executor } from "../src/executor.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== "darwin")("Executor scripting language", () => {
  it("keeps AppleScript as the default", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-language-"));
    roots.push(root);
    const result = await new Executor(root).runAppleScript({
      script: "on run argv\nreturn item 1 of argv\nend run", args: ["literal -e"], waitMs: 8000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.toString().trim()).toBe("literal -e");
  });

  it("runs fixed JavaScript and passes quotes, newlines, and leading flags as data", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-language-"));
    roots.push(root);
    const args = ["-e", "don't\n🍎\" literal"];
    const result = await new Executor(root).runAppleScript({
      script: "function run(argv) { return JSON.stringify(argv); }", args, language: "JavaScript", waitMs: 8000,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output.toString())).toEqual(args);
  });
});
