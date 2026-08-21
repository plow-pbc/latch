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

/** What a packaged build cannot work without. `vault-cli` is absent on purpose:
 * the broker falls back to a `bw` on PATH. `vault-server` is not its twin. */
const PAYLOADS = [
  "python/Python.framework",
  "python/site-packages",
  "server",
  "camoufox",
  "vault-server",
];

/** `identity` mirrors electron-builder's `mac.identity`; left off, the hook
 * falls back to CODESIGN_IDENTITY. */
const contextFor = (appOutDir: string, identity?: string | null) => ({
  appOutDir,
  packager: {
    appInfo: { productFilename: "Plow Latch" },
    platformSpecificBuildOptions: { identity },
  },
});

describe("the packaging hook refuses before it signs", () => {
  let dir: string;
  const realIdentity = process.env.CODESIGN_IDENTITY;

  const runtimeDir = () =>
    path.join(dir, "Plow Latch.app", "Contents", "Resources", "browser-runtime");

  /** A packed app whose payloads all carry something, minus `omit`. */
  const pack = (omit?: string) => {
    const runtime = runtimeDir();
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
    await expect(afterPack(contextFor(dir))).rejects.toThrow(/no signing identity/);
  });

  it("refuses an environment identity that is not the one sealing the app", async () => {
    pack();
    await expect(
      afterPack(contextFor(dir, "Developer ID Application: Someone Else (OTHER1)")),
    ).rejects.toThrow(/is not the packager's identity/);
  });

  it.each([
    { how: "never packed", empty: false },
    { how: "packed empty", empty: true },
  ])("names the runtime alone when it was $how", async ({ empty }) => {
    if (empty) fs.mkdirSync(runtimeDir(), { recursive: true });
    await expect(afterPack(contextFor(dir))).rejects.toThrow(
      /missing browser-runtime — package with/,
    );
  });

  // One expectation over every column is the claim: however a payload comes up
  // carrying no file, it is the same refusal, named the same way.
  it.each(
    PAYLOADS.flatMap((payload) => [
      { payload, how: "left out" },
      { payload, how: "packed empty", make: payload },
    ]),
  )("names $payload when it was $how", async ({ payload, make }) => {
    const runtime = pack(payload);
    if (make) fs.mkdirSync(path.join(runtime, make), { recursive: true });
    await expect(afterPack(contextFor(dir))).rejects.toThrow(
      `is missing ${path.basename(payload)} —`,
    );
  });

  it("names a payload that is all empty directories and no file", async () => {
    const runtime = pack("camoufox");
    fs.mkdirSync(path.join(runtime, "camoufox", "browsers", "official"), { recursive: true });
    await expect(afterPack(contextFor(dir))).rejects.toThrow("is missing camoufox —");
  });

  it("does not require the vault CLI, which falls back to a bw on PATH", async () => {
    // pack() never writes vault-cli. `server` is named alone only if that
    // absence is not also a refusal.
    pack("server");
    await expect(afterPack(contextFor(dir))).rejects.toThrow("is missing server —");
  });

  it("refuses a build whose identity is explicitly null", async () => {
    pack();
    await expect(afterPack(contextFor(dir, null))).rejects.toThrow(/ships unsigned/);
  });

  it("refuses a camoufox tree a fuse left without a bundle", async () => {
    const runtime = pack();
    fs.rmSync(path.join(runtime, "camoufox", "Camoufox.app"), { recursive: true });
    await expect(afterPack(contextFor(dir))).rejects.toThrow(/holds no Camoufox\.app/);
  });
});
