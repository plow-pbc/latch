/**
 * The two decisions this file exists to make testable with no display: which
 * credential leaves this Mac, and which binary a bare command name reaches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMinter, vendorDirs } from "../src/providerWiring.js";
import { PlowApi } from "../src/plowApi.js";
import { saveSettings } from "../src/settings.js";
import { vendoredProvider } from "@domo/device-core";

const GOG = vendoredProvider(["gog"])!;
const cleanups: (() => void)[] = [];
// BEFORE, not only after: `DOMO_GOG` is a documented operator override for
// driving a run against another Mac, so a developer with it exported would
// otherwise get a red suite from their own shell.
beforeEach(() => {
  delete process.env.DOMO_GOG;
  delete process.env.DOMO_SLACK;
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  delete process.env.DOMO_GOG;
  delete process.env.DOMO_SLACK;
});

function homeWith(credential: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "latch-provwire-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  saveSettings(home, { relayCredential: credential });
  return home;
}

/** A staged vendor tree: <base>/<rel>/<arch>/<name>, executable. */
function tree(rel: string, name = "gog", base = newBase()): string {
  const dir = path.join(base, rel, process.arch);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return base;
}

/** Capture what `vendorDirs` logs, restored with the rest of the cleanups. */
function captureErrors(): string[] {
  const logged: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.join(" "));
  });
  cleanups.push(() => spy.mockRestore());
  return logged;
}

function newBase(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "latch-vendor-"));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

/** A second provider, so the walk is distinguishable from a single lookup. */
const SLACK = { ...GOG, command: "slack" };

describe("buildMinter", () => {
  it("reads the credential from home on EVERY call, not once at construction", async () => {
    const home = homeWith("cred-firstfirst");
    const sent: { auth: string; url: string }[] = [];
    const api = new PlowApi("https://api.example.com", async (url, init) => {
      sent.push({
        auth: String((init?.headers as Record<string, string>).authorization),
        url: String(url),
      });
      return new Response(JSON.stringify({ data: { access_token: "ya29.token-value-here" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const minter = buildMinter({ api, home });

    await minter.mint(GOG);
    // The route comes from the provider's registry row — both halves literals.
    expect(sent[0]!.url).toBe("https://api.example.com/v1/connectors/gmail/access-token");
    // Re-pairing takes effect on the next command, not the next launch; a
    // captured credential keeps sending a stale one until the app relaunches,
    // which reads as a server problem rather than a not-yet-re-paired Mac.
    saveSettings(home, { relayCredential: "cred-secondsecond" });
    await minter.mint(GOG);
    expect(sent.map((c) => c.auth)).toEqual(["Bearer cred-firstfirst", "Bearer cred-secondsecond"]);
  });

  it("refuses before calling when this Mac is not paired", async () => {
    let called = false;
    const api = new PlowApi("https://api.example.com", async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });
    await expect(buildMinter({ api, home: homeWith("   ") }).mint(GOG)).rejects.toThrow(/not paired/);
    expect(called).toBe(false);
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

  // `PROVIDERS` has one row, so every assertion above passes byte-identically
  // whether this walks or resolves the one — the same false generality the
  // resolver was just fixed for, one caller up. These need two.
  it("accumulates one directory per provider, in order", () => {
    const base = newBase();
    for (const name of ["gog", "slack"]) tree(name, name, base);
    expect(vendorDirs({ resourcesDir: base }, [GOG, SLACK])).toEqual([
      path.join(base, "gog", process.arch),
      path.join(base, "slack", process.arch),
    ]);
  });

  it("skips an unstaged provider without stopping the next one", () => {
    const resourcesDir = tree("slack", "slack");
    expect(vendorDirs({ resourcesDir }, [GOG, SLACK])).toEqual([
      path.join(resourcesDir, "slack", process.arch),
    ]);
  });

  // The two override problems have different fixes — "names no executable
  // file" sends someone to check the path; a misnamed one IS a path that
  // exists and wants a symlink — so WHICH one it says is the value of the
  // line, and composing the wrong provider's name is invisible without this.
  it.each([
    {
      why: "composes that provider's OWN variable name",
      override: () => "/nonexistent/slack",
      has: "DOMO_SLACK",
      lacks: "DOMO_GOG",
    },
    {
      why: "says which of the two problems it is",
      override: () => path.join(tree("misnamed", "slack-0.1"), "misnamed", process.arch, "slack-0.1"),
      has: "must name a file called `slack`",
      lacks: "names no executable",
    },
  ])("$why", ({ override, has, lacks }) => {
    const logged = captureErrors();
    process.env.DOMO_SLACK = override();
    expect(vendorDirs({}, [SLACK])).toEqual([]);
    expect(logged.join("\n")).toContain(has);
    expect(logged.join("\n")).not.toContain(lacks);
  });

  it("logs what was looked for, not what was typed", () => {
    // The resolve happens inside the resolver, so echoing the raw value on a
    // relative override — the case resolve exists for — names a path nothing
    // checked.
    const logged = captureErrors();
    process.env.DOMO_SLACK = "relative/slack";
    expect(vendorDirs({}, [SLACK])).toEqual([]);
    expect(logged.join("\n")).toContain(path.resolve("relative/slack"));
  });
});
