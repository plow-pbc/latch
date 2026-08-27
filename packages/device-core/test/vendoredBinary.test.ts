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

/** A tree with an executable `<name>` at `<base>/<rel>/<arch>/<name>`. */
function tree(rel: string, name = "gog"): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gogbin-"));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, rel, process.arch);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return base;
}

describe("resolveVendoredBinary", () => {
  // The registry's claim is that a provider is one row. This function was
  // generic in NAME only — a literal `gog` in every segment and a hard-coded
  // `DOMO_GOG` — so the second provider would have found the facade was a lie.
  it("looks under the command it was asked about, not gog's", () => {
    const resourcesDir = tree("slack", "slack");
    expect(resolveVendoredBinary("slack", { resourcesDir }).path).toBe(
      path.join(resourcesDir, "slack", process.arch, "slack"),
    );
    // gog's own staging does not answer for another provider.
    expect(resolveVendoredBinary("gog", { resourcesDir }).path).toBeNull();
  });

  it("refuses an override whose basename is not the command", () => {
    // Only the DIRECTORY reaches the child, so `/tmp/gog-0.36.0` leaves it
    // finding nothing under the name `gog` — or finding a different
    // `/tmp/gog` and running that with a minted Google token. Loud beats
    // handing the credential to the wrong binary.
    const staged = tree("misnamed", "gog-0.36.0");
    process.env.DOMO_GOG = path.join(staged, "misnamed", process.arch, "gog-0.36.0");
    expect(resolveVendoredBinary("gog")).toEqual({ path: null, problem: "override-misnamed" });
  });

  it("refuses a DIRECTORY named like the command", () => {
    // `X_OK` on a directory means traversable, not runnable — it satisfied
    // both the access check and the basename check, and put its parent on the
    // child's PATH.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gogbin-"));
    cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
    fs.mkdirSync(path.join(base, "gog"));
    process.env.DOMO_GOG = path.join(base, "gog");
    expect(resolveVendoredBinary("gog")).toEqual({ path: null, problem: "override-missing" });
  });

  it("takes its override from that command's own variable", () => {
    const staged = tree("slack", "slack");
    process.env.DOMO_SLACK = path.join(staged, "slack", process.arch, "slack");
    cleanups.push(() => delete process.env.DOMO_SLACK);
    process.env.DOMO_GOG = "/nonexistent";
    expect(resolveVendoredBinary("slack").path).toBe(process.env.DOMO_SLACK);
    // ...and gog still reads its own, which is missing.
    expect(resolveVendoredBinary("gog")).toEqual({ path: null, problem: "override-missing" });
  });

  it("finds the binary a packaged app ships in Resources", () => {
    const resourcesDir = tree("gog");
    expect(resolveVendoredBinary("gog", { resourcesDir }).path).toBe(
      path.join(resourcesDir, "gog", process.arch, "gog"),
    );
  });

  it("finds the binary a from-source checkout fetched into vendor/gog", () => {
    // `just fetch-gog` writes <root>/vendor/gog/<arch>/gog, so repoRoot must be
    // the WORKSPACE root — app.getAppPath() is <root>/apps/desktop and the
    // lookup silently resolved nothing.
    const repoRoot = tree("vendor/gog");
    expect(resolveVendoredBinary("gog", { repoRoot }).path).toBe(
      path.join(repoRoot, "vendor/gog", process.arch, "gog"),
    );
  });

  it("prefers the packaged copy over a vendor tree", () => {
    const resourcesDir = tree("gog");
    const repoRoot = tree("vendor/gog");
    expect(resolveVendoredBinary("gog", { resourcesDir, repoRoot }).path).toContain(resourcesDir);
  });

  it("is null when neither is staged", () => {
    expect(resolveVendoredBinary("gog")).toEqual({ path: null, problem: "not-staged" });
    expect(resolveVendoredBinary("gog", { resourcesDir: os.tmpdir(), repoRoot: os.tmpdir() })).toEqual({
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
    expect(resolveVendoredBinary("gog", { resourcesDir: base }).path).toBeNull();
  });

  it("takes DOMO_GOG ahead of everything else", () => {
    const named = tree("gog");
    process.env.DOMO_GOG = path.join(named, "gog", process.arch, "gog");
    expect(resolveVendoredBinary("gog", { resourcesDir: tree("gog") }).path).toBe(process.env.DOMO_GOG);
  });

  it("reports a named-but-missing DOMO_GOG apart from nothing being staged", () => {
    // The operator named a path, so "not installed" would send them to run a
    // fetch they have already run. Reported, never THROWN: the only caller
    // runs inside app.whenReady().then(...) with no .catch, so a throw here
    // would reject the launch chain — no windows, no tray, no relay — over a
    // stale env var.
    process.env.DOMO_GOG = "/nonexistent/gog";
    expect(resolveVendoredBinary("gog")).toEqual({ path: null, problem: "override-missing" });
  });
});
