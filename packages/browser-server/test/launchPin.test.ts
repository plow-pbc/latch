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
  it("records the pick on first launch and reuses it after", () => {
    const p = pinPath();
    const first = pinnedEntry(pool, p);
    const second = pinnedEntry(pool, p);
    const third = pinnedEntry(pool, p);
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual({ id: first.id });
  });

  it("adopts an existing pin instead of overwriting it (the race loser's path)", () => {
    const p = pinPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // A pin written by whoever won the race.
    fs.writeFileSync(p, JSON.stringify({ id: "id-7" }));
    const chosen = pinnedEntry(pool, p);
    expect(chosen.id).toBe("id-7"); // adopted, not re-picked
    expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual({ id: "id-7" }); // unchanged
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

  it("repairs a STALE pin whose id is gone after a pool refresh, then converges", () => {
    // The regression: a browser bump regenerates the pool with fresh ids, so the
    // recorded id no longer resolves — and the old code re-randomised on every
    // launch, never repairing the file.
    const p = pinPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ id: "id-removed-by-a-browser-bump" }));
    const first = pinnedEntry(pool, p);
    expect(pool.entries.some((e) => e.id === first.id)).toBe(true); // a CURRENT entry
    expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual({ id: first.id }); // file repaired
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
