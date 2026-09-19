/**
 * The native Finder-icon helper is the behavior boundary: compile the real
 * Swift source, apply it to a disposable folder, and inspect Finder's on-disk
 * custom-icon state. A source-text assertion would prove none of that.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = path.join(repoRoot, "apps/desktop/native/plow-folder-icon.swift");
const badge = path.join(repoRoot, "apps/desktop/native/plow-badge.png");

describe.runIf(process.platform === "darwin")("native Plow folder icon", () => {
  let scratch: string;
  let helper: string;

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "plow-folder-icon-"));
    helper = path.join(scratch, "plow-folder-icon");
    const compile = spawnSync(
      "xcrun",
      [
        "swiftc",
        "-O",
        source,
        "-o",
        helper,
        "-framework",
        "AppKit",
        "-framework",
        "QuickLookThumbnailing",
      ],
      { encoding: "utf8" },
    );
    expect(compile.status, compile.stderr).toBe(0);
  });

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("applies the canonical stamped icon once", () => {
    const folder = path.join(scratch, "Plow");
    fs.mkdirSync(folder);

    const first = spawnSync(helper, [folder, badge], { encoding: "utf8" });
    expect(first.status, first.stderr).toBe(0);

    const stamp = spawnSync("/usr/bin/xattr", ["-p", "com.plow.folderIconStamp", folder], {
      encoding: "utf8",
    });
    expect(stamp.status, stamp.stderr).toBe(0);
    expect(stamp.stdout.trim()).toMatch(/^v1-os\d+$/);

    const icon = path.join(folder, "Icon\r");
    expect(fs.existsSync(icon)).toBe(true);
    const old = new Date("2001-01-01T00:00:00Z");
    fs.utimesSync(icon, old, old);

    const second = spawnSync(helper, [folder, badge], { encoding: "utf8" });
    expect(second.status, second.stderr).toBe(0);
    expect(fs.statSync(icon).mtime.toISOString()).toBe(old.toISOString());
  });

  it("does not create a missing workspace", () => {
    const missing = path.join(scratch, "missing", "Plow");
    const run = spawnSync(helper, [missing, badge], { encoding: "utf8" });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("folder does not exist");
    expect(fs.existsSync(missing)).toBe(false);
  });
});
