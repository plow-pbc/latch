/**
 * The home rename migration: a pre-rename "Domo…" folder is moved — wholesale,
 * contents intact — to its "Plow-Latch…" name, and never over the top of state
 * the new name has already accumulated. The legacy twin derives from the
 * home's folder name, because `just app` passes DOMO_HOME explicitly and the
 * per-branch and "-local" homes must migrate too; a home not named
 * "Plow-Latch…" (a throwaway test home) is never migrated.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyHome } from "../src/migrateHome.js";

let appData: string;

beforeEach(() => {
  appData = fs.mkdtempSync(path.join(os.tmpdir(), "plow-latch-migrate-"));
});

afterEach(() => {
  fs.rmSync(appData, { recursive: true, force: true });
});

describe("migrateLegacyHome", () => {
  it("moves the legacy home, contents intact", () => {
    const home = path.join(appData, "Plow-Latch");
    const legacyHome = path.join(appData, "Domo");
    fs.mkdirSync(path.join(legacyHome, "app"), { recursive: true });
    fs.writeFileSync(path.join(legacyHome, "app", "settings.json"), "{}", { mode: 0o600 });

    expect(migrateLegacyHome(home)).toBe(true);

    expect(fs.existsSync(legacyHome)).toBe(false);
    expect(fs.readFileSync(path.join(home, "app", "settings.json"), "utf8")).toBe("{}");
  });

  it("finds the twin of a branch home, -local suffix included", () => {
    // The twin comes from the folder name alone — an explicitly passed
    // DOMO_HOME (how `just app` always runs) migrates the same way.
    const home = path.join(appData, "Plow-Latch-feature-test-local");
    fs.mkdirSync(path.join(appData, "Domo-feature-test-local"), { recursive: true });

    expect(migrateLegacyHome(home)).toBe(true);
    expect(fs.existsSync(home)).toBe(true);
  });

  it("never overwrites a home the new name already has", () => {
    const home = path.join(appData, "Plow-Latch");
    const legacyHome = path.join(appData, "Domo");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "new.txt"), "new");
    fs.mkdirSync(legacyHome, { recursive: true });
    fs.writeFileSync(path.join(legacyHome, "old.txt"), "old");

    expect(migrateLegacyHome(home)).toBe(false);

    // Both survive untouched: current state wins, nothing is destroyed.
    expect(fs.readFileSync(path.join(home, "new.txt"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(legacyHome, "old.txt"), "utf8")).toBe("old");
    expect(fs.existsSync(path.join(home, "old.txt"))).toBe(false);
  });

  it("is a no-op with nothing to migrate", () => {
    const home = path.join(appData, "Plow-Latch");
    expect(migrateLegacyHome(home)).toBe(false);
    expect(fs.existsSync(home)).toBe(false);
  });

  it("is a no-op for a home with no legacy twin (throwaway DOMO_HOME)", () => {
    fs.mkdirSync(path.join(appData, "Domo"), { recursive: true });
    expect(migrateLegacyHome(path.join(appData, "throwaway"))).toBe(false);
    // The prefix has to match as a whole word, not as a substring.
    fs.mkdirSync(path.join(appData, "Domoery"), { recursive: true });
    expect(migrateLegacyHome(path.join(appData, "Plow-Latchery"))).toBe(false);
    expect(fs.existsSync(path.join(appData, "Domo"))).toBe(true);
    expect(fs.existsSync(path.join(appData, "Domoery"))).toBe(true);
  });
});
