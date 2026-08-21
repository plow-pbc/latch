/**
 * The packaging hook is the last gate before a distributable exists, and the
 * app it must never let through is the one that installs, launches and serves
 * intents with browsing dead — nothing downstream catches that. Every way it
 * refuses fires before the first codesign call, so they are pure fs + throw and
 * belong here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const afterPack = createRequire(import.meta.url)("../build/afterPack.cjs") as (
  context: unknown,
) => Promise<void>;

/** Every directory the browser runtime is made of, as packed. */
const PAYLOADS = [
  "python/Python.framework",
  "python/site-packages",
  "server",
  "camoufox",
  "vault-cli",
  "vault-server",
];

const contextFor = (appOutDir: string) => ({
  appOutDir,
  packager: { appInfo: { productFilename: "Plow Latch" } },
});

describe("the packaging hook refuses before it signs", () => {
  let dir: string;
  const realIdentity = process.env.CODESIGN_IDENTITY;

  const pack = (omit?: string) => {
    const runtime = path.join(dir, "Plow Latch.app", "Contents", "Resources", "browser-runtime");
    for (const payload of PAYLOADS) {
      if (payload === omit) continue;
      fs.mkdirSync(path.join(runtime, payload), { recursive: true });
    }
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterpack-"));
    process.env.CODESIGN_IDENTITY = "Developer ID Application: Nobody (TEAMID)";
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (realIdentity === undefined) delete process.env.CODESIGN_IDENTITY;
    else process.env.CODESIGN_IDENTITY = realIdentity;
  });

  it("leaves the per-arch temp packs to the universal merge", async () => {
    await expect(afterPack(contextFor(path.join(dir, "mac-arm64-temp")))).resolves.toBeUndefined();
  });

  it("refuses an unsigned runtime rather than shipping one macOS will not load", async () => {
    delete process.env.CODESIGN_IDENTITY;
    pack();
    await expect(afterPack(contextFor(dir))).rejects.toThrow(/CODESIGN_IDENTITY is not set/);
  });

  it("names the runtime alone when none of it was packed", async () => {
    await expect(afterPack(contextFor(dir))).rejects.toThrow(
      /missing browser-runtime — package with/,
    );
  });

  it.each(PAYLOADS)("names %s when that is the payload left out", async (payload) => {
    pack(payload);
    await expect(afterPack(contextFor(dir))).rejects.toThrow(
      `is missing ${path.basename(payload)} —`,
    );
  });
});
