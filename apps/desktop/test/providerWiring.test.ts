/**
 * The two decisions this file exists to make testable with no display: which
 * credential leaves this Mac, and which binary a bare command name reaches.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMinter, vendorDirs } from "../src/providerWiring.js";
import { saveSettings } from "../src/settings.js";
import { vendoredProvider } from "@domo/device-core";

const GOG = vendoredProvider(["gog"])!;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  delete process.env.DOMO_GOG;
});

function homeWith(credential: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "latch-provwire-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  saveSettings(home, { relayCredential: credential });
  return home;
}

/** A staged vendor tree: <base>/<rel>/<arch>/gog, executable. */
function tree(rel: string): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "latch-vendor-"));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, rel, process.arch);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "gog"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return base;
}

describe("buildMinter", () => {
  it("reads the credential from home on EVERY call, not once at construction", async () => {
    const home = homeWith("cred-firstfirst");
    const sent: string[] = [];
    const minter = buildMinter({
      apiBaseUrl: "https://api.example.com",
      home,
      fetchImpl: async (_url, init) => {
        sent.push(String((init?.headers as Record<string, string>).Authorization));
        return new Response(JSON.stringify({ data: { access_token: "ya29.token-value-here" } }), {
          status: 200,
        });
      },
    });
    await minter.mint(GOG);
    // Re-pairing takes effect on the next command, not the next launch; a
    // captured credential keeps sending a stale one until the app relaunches,
    // which reads as a server problem rather than a not-yet-re-paired Mac.
    saveSettings(home, { relayCredential: "cred-secondsecond" });
    await minter.mint(GOG);
    expect(sent).toEqual(["Bearer cred-firstfirst", "Bearer cred-secondsecond"]);
  });
});

describe("vendorDirs", () => {
  it("finds the directory a packaged app ships", () => {
    const resourcesDir = tree("gog");
    expect(vendorDirs({ resourcesDir })).toEqual([path.join(resourcesDir, "gog", process.arch)]);
  });

  it("finds the directory a from-source checkout fetched", () => {
    // `just fetch-gog` writes <root>/vendor/gog/<arch>/gog, so repoRoot must be
    // the WORKSPACE root — app.getAppPath() is <root>/apps/desktop.
    const repoRoot = tree("vendor/gog");
    expect(vendorDirs({ repoRoot })).toEqual([path.join(repoRoot, "vendor/gog", process.arch)]);
  });

  it("is empty when nothing is staged, which is not an error", () => {
    // Every non-provider command still runs; a provider one reports that it
    // is not installed, through the approval dialog rather than at launch.
    expect(vendorDirs({})).toEqual([]);
  });

  it("is empty, NOT a throw, when DOMO_GOG names nothing", () => {
    // This runs inside the launch chain, which has no .catch: a stale env var
    // must not be able to reject it.
    process.env.DOMO_GOG = "/nonexistent/gog";
    expect(() => vendorDirs({})).not.toThrow();
    expect(vendorDirs({})).toEqual([]);
  });
});
