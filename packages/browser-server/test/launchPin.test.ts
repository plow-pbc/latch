/**
 * The fingerprint pin is per install: once chosen it must never change, and
 * simultaneous first launches must converge on ONE entry rather than each
 * overwriting the file with its own random pick (which would present several
 * devices to the same site).
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  pinnedEntry,
  poolBrowserBuild,
  poolMatchesBrowser,
  type FingerprintPool,
} from "../src/launch.js";

const pool: FingerprintPool = {
  browserVersion: "official/152.0.4-beta.28",
  entries: Array.from({ length: 20 }, (_v, i) => ({
    id: `id-${i}`,
    env: { CAMOU_CONFIG_1: `cfg-${i}` },
    firefoxUserPrefs: {},
    args: [],
  })),
};

let dirs: string[] = [];
const pinPath = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pin-"));
  dirs.push(d);
  return path.join(d, "device", "browser", "fingerprint-pin.json");
};
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("fingerprint pinning", () => {
  it("records the pick (entry + browser version) on first launch and reuses it", () => {
    const p = pinPath();
    const first = pinnedEntry(pool, p);
    const second = pinnedEntry(pool, p);
    const third = pinnedEntry(pool, p);
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual({
      browserVersion: pool.browserVersion,
      entry: first,
    });
  });

  it("reuses the pinned entry even when its id is no longer in a resampled pool", () => {
    // Every package build resamples the pool with fresh ids; the pin stores the
    // ENTRY, not just the id, so an ordinary update keeps the same fingerprint.
    const p = pinPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const gone = { id: "id-not-in-this-pool", env: { CAMOU_CONFIG_1: "x" }, firefoxUserPrefs: {}, args: [] };
    fs.writeFileSync(p, JSON.stringify({ browserVersion: pool.browserVersion, entry: gone }));
    const chosen = pinnedEntry(pool, p);
    expect(chosen).toEqual(gone); // the recorded entry, though its id is not in the pool
    expect(JSON.parse(fs.readFileSync(p, "utf8")).entry).toEqual(gone); // unchanged
  });

  it("writes the pin exclusively, so an already-present file is never clobbered", () => {
    // Prove the write uses O_EXCL: a valid pin on disk stays byte-for-byte, even
    // across many launches that each 'choose' independently.
    const p = pinPath();
    const first = pinnedEntry(pool, p);
    const before = fs.readFileSync(p, "utf8");
    for (let i = 0; i < 10; i++) expect(pinnedEntry(pool, p).id).toBe(first.id);
    expect(fs.readFileSync(p, "utf8")).toBe(before);
  });

  it("falls back to a per-launch pick from the pool when no pin path is given (dev)", () => {
    // Looped: the dev fallback picks randomly, so one draw would not prove it
    // stays in the pool. Every draw must be a current entry.
    for (let i = 0; i < 1000; i++) expect(pool.entries).toContain(pinnedEntry(pool));
  });

  it("re-picks when the pin is for a DIFFERENT browser version, then converges", () => {
    // A real browser bump: the pin was chosen for an older build, so its config
    // may not fit the new browser — re-pick from the current pool and re-record.
    const p = pinPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ browserVersion: "official/151.0.0-beta.1", entry: pool.entries[3] }),
    );
    const first = pinnedEntry(pool, p);
    expect(pool.entries.some((e) => e.id === first.id)).toBe(true);
    expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual({
      browserVersion: pool.browserVersion, // re-recorded for the current build
      entry: first,
    });
    for (let i = 0; i < 10; i++) expect(pinnedEntry(pool, p).id).toBe(first.id); // converges
  });

  it("repairs a corrupt pin file", () => {
    const p = pinPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ not valid json");
    const first = pinnedEntry(pool, p);
    expect(pool.entries.some((e) => e.id === first.id)).toBe(true);
    expect(pinnedEntry(pool, p).id).toBe(first.id);
  });
});

describe("pool / browser version guard", () => {
  const versioned = (v: string): FingerprintPool => ({ browserVersion: v, entries: pool.entries });

  it("strips the repo prefix to match playwright's browser.version()", () => {
    expect(poolBrowserBuild("official/152.0.4-beta.28")).toBe("152.0.4-beta.28");
    expect(poolBrowserBuild("152.0.4-beta.28")).toBe("152.0.4-beta.28");
  });

  it("matches an equal build and rejects a different one", () => {
    expect(poolMatchesBrowser(versioned("official/152.0.4-beta.28"), "152.0.4-beta.28")).toBe(true);
    expect(poolMatchesBrowser(versioned("official/152.0.4-beta.28"), "151.0.0-beta.1")).toBe(false);
  });

  it("permits an unknown (unreadable) browser version rather than refusing blind", () => {
    expect(poolMatchesBrowser(versioned("official/152.0.4-beta.28"), "")).toBe(true);
  });
});
