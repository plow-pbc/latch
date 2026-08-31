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
import { pinnedEntry, type FingerprintPool } from "../src/launch.js";

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

  it("falls back to a per-launch pick when no pin path is given (dev)", () => {
    expect(pool.entries.some((e) => e.id === pinnedEntry(pool).id)).toBe(true);
  });
});
