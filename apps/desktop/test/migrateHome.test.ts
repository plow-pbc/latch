/**
 * The home rename migration: a pre-rename "Domo…" folder is moved — wholesale,
 * contents intact — to its "Plow-Latch…" name, and never over the top of state
 * the new name has already accumulated.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyHome } from "../src/migrateHome.js";

let appData: string;
let home: string;
let legacyHome: string;

beforeEach(() => {
  appData = fs.mkdtempSync(path.join(os.tmpdir(), "plow-latch-migrate-"));
  home = path.join(appData, "Plow-Latch");
  legacyHome = path.join(appData, "Domo");
});

afterEach(() => {
  fs.rmSync(appData, { recursive: true, force: true });
});

describe("migrateLegacyHome", () => {
  it("moves the legacy home, contents intact", () => {
    fs.mkdirSync(path.join(legacyHome, "app"), { recursive: true });
    fs.writeFileSync(path.join(legacyHome, "app", "settings.json"), "{}", { mode: 0o600 });

    expect(migrateLegacyHome({ home, legacyHome })).toBe(true);

    expect(fs.existsSync(legacyHome)).toBe(false);
    expect(fs.readFileSync(path.join(home, "app", "settings.json"), "utf8")).toBe("{}");
  });

  it("never overwrites a home the new name already has", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "new.txt"), "new");
    fs.mkdirSync(legacyHome, { recursive: true });
    fs.writeFileSync(path.join(legacyHome, "old.txt"), "old");

    expect(migrateLegacyHome({ home, legacyHome })).toBe(false);

    // Both survive untouched: current state wins, nothing is destroyed.
    expect(fs.readFileSync(path.join(home, "new.txt"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(legacyHome, "old.txt"), "utf8")).toBe("old");
    expect(fs.existsSync(path.join(home, "old.txt"))).toBe(false);
  });

  it("is a no-op with nothing to migrate", () => {
    expect(migrateLegacyHome({ home, legacyHome })).toBe(false);
    expect(fs.existsSync(home)).toBe(false);
  });

  it("is a no-op for a home with no legacy twin (throwaway DOMO_HOME)", () => {
    expect(migrateLegacyHome({ home, legacyHome: undefined })).toBe(false);
  });
});
