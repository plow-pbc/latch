/**
 * Which of these two branches resolves decides whether shipped users get the
 * Google tools at all, and neither had an assertion — which is exactly why a
 * from-source lookup that could never resolve went unnoticed.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveVendoredBinary } from "../src/providers/vendoredBinary.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  delete process.env.DOMO_GOG;
});

/** A tree with an executable gog at `<base>/<rel>/<arch>/gog`. */
function tree(rel: string): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gogbin-"));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, rel, process.arch);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "gog"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return base;
}

describe("resolveVendoredBinary", () => {
  it("finds the binary a packaged app ships in Resources", () => {
    const resourcesDir = tree("gog");
    expect(resolveVendoredBinary({ resourcesDir }).path).toBe(
      path.join(resourcesDir, "gog", process.arch, "gog"),
    );
  });

  it("finds the binary a from-source checkout fetched into vendor/gog", () => {
    // `just fetch-gog` writes <root>/vendor/gog/<arch>/gog, so repoRoot must be
    // the WORKSPACE root — app.getAppPath() is <root>/apps/desktop and the
    // lookup silently resolved nothing.
    const repoRoot = tree("vendor/gog");
    expect(resolveVendoredBinary({ repoRoot }).path).toBe(
      path.join(repoRoot, "vendor/gog", process.arch, "gog"),
    );
  });

  it("prefers the packaged copy over a vendor tree", () => {
    const resourcesDir = tree("gog");
    const repoRoot = tree("vendor/gog");
    expect(resolveVendoredBinary({ resourcesDir, repoRoot }).path).toContain(resourcesDir);
  });

  it("is null when neither is staged", () => {
    expect(resolveVendoredBinary({})).toEqual({ path: null, problem: "not-staged" });
    expect(resolveVendoredBinary({ resourcesDir: os.tmpdir(), repoRoot: os.tmpdir() })).toEqual({
      path: null,
      problem: "not-staged",
    });
  });

  it("ignores a non-executable file", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gogbin-"));
    cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
    const dir = path.join(base, "gog", process.arch);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "gog"), "", { mode: 0o644 });
    expect(resolveVendoredBinary({ resourcesDir: base }).path).toBeNull();
  });

  it("takes DOMO_GOG ahead of everything else", () => {
    const named = tree("gog");
    process.env.DOMO_GOG = path.join(named, "gog", process.arch, "gog");
    expect(resolveVendoredBinary({ resourcesDir: tree("gog") }).path).toBe(process.env.DOMO_GOG);
  });

  it("reports a named-but-missing DOMO_GOG apart from nothing being staged", () => {
    // The operator named a path, so "not installed" would send them to run a
    // fetch they have already run. Reported, never THROWN: the only caller
    // runs inside app.whenReady().then(...) with no .catch, so a throw here
    // would reject the launch chain — no windows, no tray, no relay — over a
    // stale env var.
    process.env.DOMO_GOG = "/nonexistent/gog";
    expect(resolveVendoredBinary({})).toEqual({ path: null, problem: "override-missing" });
  });
});
