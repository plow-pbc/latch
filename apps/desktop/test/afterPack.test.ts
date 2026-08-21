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

  /** A packed app whose payloads all carry something, minus `omit`. */
  const pack = (omit?: string) => {
    const runtime = path.join(dir, "Plow Latch.app", "Contents", "Resources", "browser-runtime");
    for (const payload of PAYLOADS) {
      if (payload === omit) continue;
      fs.mkdirSync(path.join(runtime, payload), { recursive: true });
      fs.writeFileSync(path.join(runtime, payload, "carried"), "");
    }
    if (omit !== "camoufox") {
      fs.mkdirSync(path.join(runtime, "camoufox", "Camoufox.app"), { recursive: true });
    }
    return runtime;
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

  // One expectation over both columns is the claim: absent and empty are the
  // same refusal, named the same way.
  it.each(PAYLOADS.flatMap((payload) => [
    { payload, how: "left out", empty: false },
    { payload, how: "packed empty", empty: true },
  ]))("names $payload when it was $how", async ({ payload, empty }) => {
    const runtime = pack(payload);
    if (empty) fs.mkdirSync(path.join(runtime, payload), { recursive: true });
    await expect(afterPack(contextFor(dir))).rejects.toThrow(
      `is missing ${path.basename(payload)} —`,
    );
  });

  it("refuses a camoufox tree a fuse left without a bundle", async () => {
    const runtime = pack();
    fs.rmSync(path.join(runtime, "camoufox", "Camoufox.app"), { recursive: true });
    await expect(afterPack(contextFor(dir))).rejects.toThrow(/holds no Camoufox\.app/);
  });
});
