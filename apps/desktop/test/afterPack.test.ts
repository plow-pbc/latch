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
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const afterPack = createRequire(import.meta.url)("../build/afterPack.cjs") as (
  context: unknown,
) => Promise<void>;

/** What a packaged build cannot work under browser-runtime: only the Camoufox
 * tree now. No Python ships, the server is a Node script in app.asar.unpacked,
 * and the vault ships no payload (TypeScript in dist/ plus a Keychain item). */
const PAYLOADS = ["camoufox"];

/** Every bundled plugin (apps/desktop/plugins/<name>), read the same way the
 * hook does: from disk, not a fixture list, so a new plugin's manifest is
 * covered here without a matching edit to this file. */
const PLUGINS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins");
const PLUGINS: { name: string; binaries: { name: string }[] }[] = fs
  .readdirSync(PLUGINS_DIR)
  .filter((name) => fs.existsSync(path.join(PLUGINS_DIR, name, "latch-plugin.json")))
  .map((name) => ({
    name,
    // `?? []`: a source-only plugin (wiki) omits `runtime.binaries` entirely,
    // same as manifest.ts's own parser defaults it — nothing here to pack or
    // check per-binary, but the reader must not throw on the day one exists.
    binaries: JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, name, "latch-plugin.json"), "utf8")).runtime
      .binaries ?? [],
  }));

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

  /** Every bundled plugin as production stages it: one executable per binary,
   * per arch, at runtime/<arch>/bin/<binary name> — what stageBinaries writes. */
  const packPlugins = () => {
    for (const { name, binaries } of PLUGINS) {
      for (const { name: binary } of binaries) {
        for (const arch of ["arm64", "x64"]) {
          const bin = path.join(resourcesDir(), "plugins", name, "runtime", arch, "bin", binary);
          fs.mkdirSync(path.dirname(bin), { recursive: true });
          fs.writeFileSync(bin, "#!/bin/sh\n");
        }
      }
    }
  };

  /** A universal (fat) Mach-O header carrying x86_64 + arm64 — all the hook
   * reads. 20-byte nfat_arch entries, cputype first, big-endian. */
  const fatUniversalHeader = () => {
    const buf = Buffer.alloc(8 + 2 * 20);
    buf.writeUInt32BE(0xcafebabe, 0);
    buf.writeUInt32BE(2, 4);
    buf.writeUInt32BE(0x01000007, 8); // x86_64
    buf.writeUInt32BE(0x0100000c, 28); // arm64
    return buf;
  };

  /** A thin little-endian 64-bit Mach-O header for one arch. */
  const thinHeader = (cputype: number) => {
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(0xfeedfacf, 0);
    buf.writeUInt32LE(cputype, 4);
    return buf;
  };

  const keychainAddonPath = () =>
    path.join(
      resourcesDir(), "app.asar.unpacked", "node_modules", "@domo", "native-keychain",
      "build", "Release", "keychain.node",
    );

  const packKeychainAddon = (bytes: Buffer = fatUniversalHeader()) => {
    fs.mkdirSync(path.dirname(keychainAddonPath()), { recursive: true });
    fs.writeFileSync(keychainAddonPath(), bytes);
  };

  /** A packed app whose payloads all carry something, minus `omit`. */
  const pack = (omit?: string) => {
    const runtime = runtimeDir();
    packPlugins();
    if (omit !== "keychain-addon") packKeychainAddon();
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
    // Credential-exchange path knobs some tests set; never set outside them.
    delete process.env.DOMO_CX_APPEX_SOURCE;
    delete process.env.DOMO_CX_PROFILE;
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
    // Past both identity guards on the env alone: the camoufox refusal only
    // happens after an identity resolved.
    pack("camoufox");
    await expect(afterPack(contextFor(dir, {}))).rejects.toThrow("camoufox browser payload");
  });

  it("refuses an environment identity that is not the one sealing the app", async () => {
    pack();
    await expect(
      afterPack(contextFor(dir, { identity: "Developer ID Application: Someone Else (OTHER1)" })),
    ).rejects.toThrow(/is not the packager's identity/);
  });

  // However the camoufox payload comes up carrying no file — the runtime never
  // packed, packed empty, or all empty directories — it is the same refusal.
  it.each([
    { how: "never packed", prep: () => {} },
    { how: "runtime packed empty", prep: () => fs.mkdirSync(runtimeDir(), { recursive: true }) },
    { how: "camoufox left out", prep: () => pack("camoufox") },
    {
      how: "camoufox all empty directories",
      prep: () => {
        const runtime = pack("camoufox");
        fs.mkdirSync(path.join(runtime, "camoufox", "browsers", "official"), { recursive: true });
      },
    },
  ])("refuses when the camoufox payload was $how", async ({ prep }) => {
    prep();
    await expect(afterPack(contextFor(dir))).rejects.toThrow("camoufox browser payload");
  });

  // The addon's install script is tolerant on purpose (dev boxes without
  // Xcode CLT); the hook is where a release that lost the vault's SecItem
  // provider gets stopped instead of silently downgrading to safeStorage.
  it.each([
    { how: "absent", damage: () => fs.rmSync(keychainAddonPath()) },
    { how: "empty", damage: () => fs.writeFileSync(keychainAddonPath(), "") },
  ])("refuses a pack whose native-keychain addon is $how", async ({ damage }) => {
    pack();
    damage();
    await expect(afterPack(contextFor(dir))).rejects.toThrow(/no native-keychain addon/);
  });

  it.each([
    { arch: "arm64-only", cputype: 0x0100000c, missing: "x86_64" },
    { arch: "x86_64-only", cputype: 0x01000007, missing: "arm64" },
  ])("refuses a THIN ($arch) addon — it lands broken on the other arch's users", async ({ cputype, missing }) => {
    pack();
    packKeychainAddon(thinHeader(cputype));
    await expect(afterPack(contextFor(dir))).rejects.toThrow(
      new RegExp(`native-keychain addon is missing ${missing}`),
    );
  });

  it("refuses a build whose identity is explicitly null", async () => {
    pack();
    await expect(afterPack(contextFor(dir, { identity: null }))).rejects.toThrow(/ships unsigned/);
  });

  // Credential exchange (docs/CREDENTIAL-EXCHANGE.md) is UNCONDITIONAL in a
  // packaged build: the app is always signed with the AutoFill entitlement,
  // so a pack that quietly dropped the extension, the addon, or the Swift
  // shim would ship a release where the feature silently stopped. Every
  // piece missing is a refusal, exactly like the keychain addon's.
  describe("the credential-exchange pieces are mandatory", () => {
    const receivingPaths = () => [
      path.join(
        resourcesDir(), "app.asar.unpacked", "node_modules",
        "@domo", "native-credential-import", "build", "Release", "credential_import.node",
      ),
      path.join(resourcesDir(), "native", "libdomo-credential-import.dylib"),
    ];

    /** The addon + shim as production packs them: one universal binary each. */
    const packReceiving = () => {
      for (const file of receivingPaths()) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, fatUniversalHeader());
      }
    };

    /** A built appex as build-native.mjs leaves it, minus nothing. */
    const packAppex = (bytes: Buffer = fatUniversalHeader()) => {
      const appex = path.join(dir, "fixture.appex");
      fs.mkdirSync(path.join(appex, "Contents", "MacOS"), { recursive: true });
      fs.writeFileSync(path.join(appex, "Contents", "MacOS", "PlowLatchCredentialProvider"), bytes);
      process.env.DOMO_CX_APPEX_SOURCE = appex;
      return appex;
    };

    beforeEach(() => {
      pack();
      packReceiving();
    });

    it.each([
      { what: "addon", at: 0 },
      { what: "shim", at: 1 },
    ])("refuses a pack whose credential-import $what is absent", async ({ at }) => {
      fs.rmSync(receivingPaths()[at]!);
      await expect(afterPack(contextFor(dir))).rejects.toThrow(/no credential-import/);
    });

    it("refuses a THIN shim — it lands broken on the other arch's users", async () => {
      fs.writeFileSync(receivingPaths()[1]!, thinHeader(0x0100000c));
      await expect(afterPack(contextFor(dir))).rejects.toThrow(/credential-import shim is missing x86_64/);
    });

    it("refuses when no appex was built", async () => {
      process.env.DOMO_CX_APPEX_SOURCE = path.join(dir, "never-built.appex");
      process.env.DOMO_CX_PROFILE = path.join(dir, "unused.provisionprofile");
      await expect(afterPack(contextFor(dir))).rejects.toThrow(/no built credential-provider appex/);
    });

    it("refuses when the extension's provisioning profile is missing", async () => {
      packAppex();
      process.env.DOMO_CX_PROFILE = path.join(dir, "missing.provisionprofile");
      await expect(afterPack(contextFor(dir))).rejects.toThrow(/provisionprofile is missing/);
    });

    it.each([
      { arch: "arm64-only", cputype: 0x0100000c, missing: "x86_64" },
      { arch: "x86_64-only", cputype: 0x01000007, missing: "arm64" },
    ])("refuses a THIN ($arch) appex — it lands broken on the other arch's users", async ({ cputype, missing }) => {
      packAppex(thinHeader(cputype));
      const profile = path.join(dir, "fixture.provisionprofile");
      fs.writeFileSync(profile, "not a real profile; the arch gate fires first");
      process.env.DOMO_CX_PROFILE = profile;
      await expect(afterPack(contextFor(dir))).rejects.toThrow(
        new RegExp(`credential-provider appex is missing ${missing}`),
      );
    });
  });

  // One expectation over every way a staged binary can be unusable, for every
  // binary of every bundled plugin. The silent half-install is the hazard: a
  // tree carrying only the packaging Mac's arch clears every other gate and
  // reaches the other arch's users with nothing. Checked against the binary's
  // own name (what stageBinaries writes to bin/), not argv[0] — and on the
  // BINARY with a size, so a zero-byte file left by a half-written extract
  // does not pass. `arches` is what the refusal must name: the both-missing
  // row is why it is the joined list rather than the first one found.
  //
  // The `absent` rows are also the stray-file case the hook's own comment
  // names: they take the binary out and leave the directory standing, which
  // is exactly what a `bare` check on the directory would wave through.
  it.each(
    PLUGINS.flatMap(({ name, binaries }) =>
      binaries.flatMap((binary) => {
        const bin = (root: string, arch: string) =>
          path.join(root, "runtime", arch, "bin", binary.name);
        return [
          ...["arm64", "x64"].map((arch) => ({
            name, binary: binary.name, how: `absent for ${arch}`, arches: arch,
            damage: (root: string) => fs.rmSync(bin(root, arch)),
          })),
          {
            name, binary: binary.name, how: "a zero-byte binary for arm64", arches: "arm64",
            damage: (root: string) => fs.writeFileSync(bin(root, "arm64"), ""),
          },
          {
            name, binary: binary.name, how: "absent for both arches", arches: "arm64, x64",
            damage: (root: string) => {
              for (const arch of ["arm64", "x64"]) fs.rmSync(bin(root, arch));
            },
          },
        ];
      }),
    ),
  )("refuses $name/$binary when it is $how", async ({ name, binary, arches, damage }) => {
    pack();
    damage(path.join(resourcesDir(), "plugins", name));
    const failure = await afterPack(contextFor(dir)).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    // Anchored to the arch gate: without it, any error naming both arches
    // passes — a refusal enumerating missing binary PATHS would, without the
    // gate ever emitting its summary.
    expect((failure as Error).message).toContain(`no ${name} plugin's ${binary} for ${arches}`);
  });

  it("refuses a camoufox tree a fuse left without a bundle", async () => {
    const runtime = pack();
    fs.rmSync(path.join(runtime, "camoufox", "Camoufox.app"), { recursive: true });
    await expect(afterPack(contextFor(dir))).rejects.toThrow(/holds no Camoufox\.app/);
  });
});
