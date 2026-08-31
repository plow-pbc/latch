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

/** What a packaged build cannot work without. The vault ships no payload:
 * it is TypeScript in dist/ plus a Keychain item. */
const PAYLOADS = [
  "python/Python.framework",
  "python/site-packages",
  "server",
  "camoufox",
];

// @ts-expect-error — a build-time .mjs with no type declarations.
import { VENDORED } from "../../../scripts/vendored-providers.mjs";

/** Every vendored CLI the packed app must carry, and the arches it stages. */
const PROVIDERS: { command: string; arches: Record<string, unknown> }[] = VENDORED;

const IDENTITY = "Developer ID Application: Nobody (TEAMID)";

/** `mac` is electron-builder's resolved mac config. It defaults to carrying the
 * identity the environment also has, because that agreement is what every
 * packaging recipe produces; pass `{}` for a build that configured none. */
const contextFor = (appOutDir: string, mac: { identity?: string | null } = { identity: IDENTITY }) => ({
  appOutDir,
  packager: {
    appInfo: { productFilename: "Plow Latch" },
    platformSpecificBuildOptions: mac,
  },
});

describe("the packaging hook refuses before it signs", () => {
  let dir: string;
  const realIdentity = process.env.CODESIGN_IDENTITY;

  const resourcesDir = () => path.join(dir, "Plow Latch.app", "Contents", "Resources");
  const runtimeDir = () => path.join(resourcesDir(), "browser-runtime");

  /** Every provider as production ships it: one thin binary per arch. */
  const packProviders = () => {
    for (const { command, arches } of PROVIDERS) {
      for (const arch of Object.keys(arches)) {
        fs.mkdirSync(path.join(resourcesDir(), "providers", command, arch), { recursive: true });
        fs.writeFileSync(path.join(resourcesDir(), "providers", command, arch, command), "#!/bin/sh\n");
      }
    }
  };

  /** A packed app whose payloads all carry something, minus `omit`. */
  const pack = (omit?: string) => {
    const runtime = runtimeDir();
    packProviders();
    for (const payload of PAYLOADS) {
      if (payload === omit) continue;
      fs.mkdirSync(path.join(runtime, payload), { recursive: true });
      fs.writeFileSync(path.join(runtime, payload, "carried"), "");
    }
    // The payload the hook looks inside, built as production ships it.
    if (omit !== "camoufox") {
      fs.mkdirSync(path.join(runtime, "camoufox", "Camoufox.app"), { recursive: true });
    }
    return runtime;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterpack-"));
    process.env.CODESIGN_IDENTITY = IDENTITY;
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
    await expect(afterPack(contextFor(dir, {}))).rejects.toThrow(/no signing identity/);
  });

  it("falls back to the environment when the packager configured none", async () => {
    // Past both identity guards on the env alone: `server` is named, which only
    // happens after an identity resolved.
    pack("server");
    await expect(afterPack(contextFor(dir, {}))).rejects.toThrow("is missing server —");
  });

  it("refuses an environment identity that is not the one sealing the app", async () => {
    pack();
    await expect(
      afterPack(contextFor(dir, { identity: "Developer ID Application: Someone Else (OTHER1)" })),
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

  it("does not require any vault payload — the vault is code, not a bundle", async () => {
    // pack() writes no vault-anything. `server` is named alone only if that
    // absence is not also a refusal.
    pack("server");
    await expect(afterPack(contextFor(dir))).rejects.toThrow("is missing server —");
  });

  it("refuses a build whose identity is explicitly null", async () => {
    pack();
    await expect(afterPack(contextFor(dir, { identity: null }))).rejects.toThrow(/ships unsigned/);
  });

  // One expectation over every way an arch can be unusable, for every arch of
  // every row: absent, empty and stray-file-only are the same failure to the
  // gate — the binary is not there.
  it.each(
    PROVIDERS.flatMap(({ command, arches }) =>
      Object.keys(arches).flatMap((arch) =>
        [
          { how: "absent", damage: (d: string) => fs.rmSync(d, { recursive: true, force: true }) },
          { how: "a zero-byte binary", damage: (d: string) => fs.writeFileSync(path.join(d, command), "") },
          {
            how: "an arch folder carrying only a stray file",
            damage: (d: string) => {
              fs.rmSync(path.join(d, command));
              fs.writeFileSync(path.join(d, ".DS_Store"), "junk");
            },
          },
        ].map((c) => ({ ...c, command, arch })),
      ),
    ),
  )("refuses $command/$arch when it is $how", async ({ command, arch, damage }) => {
    // Silent half-install: a tree carrying only the packaging Mac's arch clears
    // every other gate and reaches the other arch's users with nothing.
    pack();
    damage(path.join(resourcesDir(), "providers", command, arch));
    await expect(afterPack(contextFor(dir))).rejects.toThrow(
      new RegExp(`no ${command} for ${arch}`),
    );
  });

  it.each(PROVIDERS)("names every arch $command is missing, not just the first", async (p) => {
    // One run of `just fetch-vendored` fixes them all; being told about one
    // arch at a time means one package run per arch to learn that.
    //
    // MEMBERSHIP, not a joined string. The claim is that every missing arch is
    // named — a hook that sorted them, or listed them one per line, would still
    // satisfy it. Asserting the join would pin the row's declaration order and
    // the separator, and fail a correct hook.
    pack();
    fs.rmSync(path.join(resourcesDir(), "providers", p.command), { recursive: true, force: true });
    const failure = await afterPack(contextFor(dir)).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    // Anchored to the arch gate, then membership within it. Without the anchor
    // any error naming both arches passes — a refusal enumerating missing
    // binary PATHS would, without the gate ever emitting its summary.
    expect(message).toContain(`no ${p.command} for`);
    for (const arch of Object.keys(p.arches)) expect(message).toContain(arch);
  });

  it("refuses a camoufox tree a fuse left without a bundle", async () => {
    const runtime = pack();
    fs.rmSync(path.join(runtime, "camoufox", "Camoufox.app"), { recursive: true });
    await expect(afterPack(contextFor(dir))).rejects.toThrow(/holds no Camoufox\.app/);
  });
});
