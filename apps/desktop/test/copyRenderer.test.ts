/**
 * The build's own guard, exercised.
 *
 * `copy-renderer.mjs` parses the renderer scripts before installing them,
 * because nothing else in the build looks at those files — a syntax error in
 * one used to reach a window and leave the app inert. This is the reproducer
 * for that: a malformed renderer must stop the script, and the message must
 * name the file and where the parse gave up, or the failure is not actionable.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts/copy-renderer.mjs",
);
const rendererMain = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/renderer/main.js",
);

let root: string;

/** An app-shaped tree: the real script, beside a renderer of our choosing. */
function plant(main: string): string {
  const desktop = path.join(root, "apps/desktop");
  fs.mkdirSync(path.join(desktop, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(desktop, "src/renderer"), { recursive: true });
  // The script reads a renderer `.js` with the module goal the browser gives
  // it, which is what `"type": "module"` decides for `node --check`.
  fs.writeFileSync(path.join(root, "package.json"), `{"type":"module"}`);
  fs.copyFileSync(script, path.join(desktop, "scripts/copy-renderer.mjs"));
  fs.writeFileSync(path.join(desktop, "src/renderer/main.js"), main);
  return path.join(desktop, "scripts/copy-renderer.mjs");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "copy-renderer-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

it("refuses to install a renderer that will not parse, and says where", () => {
  // An unterminated function — the exact shape a bad merge produced.
  const run = spawnSync(process.execPath, [plant("function open() {\n")], { encoding: "utf8" });

  expect(run.status).not.toBe(0);
  const output = `${run.stdout}${run.stderr}`;
  expect(output).toContain("main.js");
  // The parse location, so the failure points at a line rather than a file.
  expect(output).toMatch(/main\.js:\d+/);
  expect(output).toContain("SyntaxError");
  // And nothing was installed on the way past.
  expect(fs.existsSync(path.join(root, "apps/desktop/dist/renderer/main.js"))).toBe(false);
});

it("installs a renderer that parses", () => {
  const run = spawnSync(process.execPath, [plant("export const ok = 1;\n")], { encoding: "utf8" });

  expect(run.status).toBe(0);
  expect(fs.readFileSync(path.join(root, "apps/desktop/dist/renderer/main.js"), "utf8")).toContain(
    "export const ok = 1;",
  );
});

it("renders failed cloud agents as terminal red with a useful reason", () => {
  const source = fs.readFileSync(rendererMain, "utf8");
  const body = source.match(
    /function cloudStatus\(status, failureReason\) \{([\s\S]*?)\n\}/,
  )?.[1];
  expect(body).toBeDefined();
  const cloudStatus = new Function("status", "failureReason", body!) as (
    status: string,
    failureReason: string | null,
  ) => { tone: string; label: string };

  expect(cloudStatus("failed", "provider_unreachable")).toMatchObject({
    tone: "red",
    label: expect.stringMatching(/provider.*unreachable/i),
  });
  expect(cloudStatus("failed", "validation_failed").label).toMatch(/retrying will not help.*human/i);
  expect(cloudStatus("failed", "capacity_exhausted")).toMatchObject({
    tone: "red",
    label: expect.stringContaining("capacity_exhausted"),
  });
});
