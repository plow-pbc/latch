/** The Electron boundary launches a real process; no child-process mock. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPlowFolderIcon } from "../src/plowFolderIcon.js";

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "plow-folder-launch-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function executable(name: string, source: string): string {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, source, { mode: 0o755 });
  return file;
}

describe("applyPlowFolderIcon", () => {
  it("passes the workspace and badge paths to the native helper", async () => {
    const capture = path.join(scratch, "arguments.txt");
    const helper = executable(
      "capture.mjs",
      `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(capture)}, process.argv.slice(2).join("\\n") + "\\n");
`,
    );

    await applyPlowFolderIcon({
      folderPath: "/Users/owner/Plow",
      helperPath: helper,
      badgePath: "/bundle/native/plow-badge.png",
      platform: "darwin",
    });

    expect(fs.readFileSync(capture, "utf8")).toBe(
      "/Users/owner/Plow\n/bundle/native/plow-badge.png\n",
    );
  });

  it("does nothing away from macOS", async () => {
    const logs: string[] = [];
    await applyPlowFolderIcon({
      folderPath: "/Users/owner/Plow",
      helperPath: path.join(scratch, "does-not-exist"),
      badgePath: "/bundle/native/plow-badge.png",
      platform: "linux",
      log: (message) => logs.push(message),
    });

    expect(logs).toEqual([]);
  });

  it("keeps cosmetic failure out of startup and logs no helper detail", async () => {
    const helper = executable(
      "fail.mjs",
      `#!/usr/bin/env node
process.stderr.write("secret helper detail /Users/owner/Plow\\n");
process.exit(1);
`,
    );
    const logs: string[] = [];

    await expect(applyPlowFolderIcon({
      folderPath: "/Users/owner/Plow",
      helperPath: helper,
      badgePath: "/bundle/native/plow-badge.png",
      platform: "darwin",
      log: (message) => logs.push(message),
    })).resolves.toBeUndefined();

    expect(logs).toEqual([
      "[plow-folder] could not apply the Finder icon; the workspace is still available",
    ]);
  });
});
