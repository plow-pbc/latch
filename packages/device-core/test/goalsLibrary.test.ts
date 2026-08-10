/**
 * Goals are plain, user-owned entries: defaults seed on first run, are
 * deletable like any other (deletions persist across reloads), and
 * restoreDefaults re-adds missing ones. No "built-in" distinction.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoalsLibrary } from "@domo/device-core";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-goals-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "goals.json");
}

describe("GoalsLibrary", () => {
  it("seeds default goals on first run and persists them", () => {
    const file = tempFile();
    const lib = new GoalsLibrary(file);
    expect(lib.all().length).toBeGreaterThan(0);
    expect(lib.all().map((g) => g.title)).toContain("Disk usage report");
    // Every goal has an id and no `premade` field.
    for (const g of lib.all()) {
      expect(g.id).toBeTypeOf("string");
      expect((g as Record<string, unknown>).premade).toBeUndefined();
    }
    expect(fs.existsSync(file)).toBe(true);
  });

  it("a deleted default stays deleted across reloads", () => {
    const file = tempFile();
    const lib = new GoalsLibrary(file);
    const target = lib.all().find((g) => g.title === "Disk usage report")!;
    lib.remove(target.id);
    expect(lib.all().some((g) => g.title === "Disk usage report")).toBe(false);
    // Reload from disk: the deletion must persist (no forced re-seed).
    const reloaded = new GoalsLibrary(file);
    expect(reloaded.all().some((g) => g.title === "Disk usage report")).toBe(false);
  });

  it("restoreDefaults re-adds missing defaults without duplicating existing ones", () => {
    const file = tempFile();
    const lib = new GoalsLibrary(file);
    const before = lib.all().length;
    const disk = lib.all().find((g) => g.title === "Disk usage report")!;
    lib.remove(disk.id);
    lib.restoreDefaults();
    expect(lib.all().some((g) => g.title === "Disk usage report")).toBe(true);
    // Restoring again is idempotent — no duplicate titles.
    lib.restoreDefaults();
    const titles = lib.all().map((g) => g.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(lib.all().length).toBe(before);
  });

  it("allows adding a goal without a title, deriving one from the text", () => {
    const lib = new GoalsLibrary(tempFile());
    const g = lib.add({ title: "  ", text: "Clean up my Downloads folder\nand more" });
    expect(g.title).toBe("Clean up my Downloads folder");
    expect(g.text).toContain("Clean up my Downloads folder");
  });

  it("falls back to 'Untitled goal' when both title and text are empty", () => {
    const lib = new GoalsLibrary(tempFile());
    expect(lib.add({ title: "", text: "" }).title).toBe("Untitled goal");
  });

  it("truncates a long derived title", () => {
    const lib = new GoalsLibrary(tempFile());
    const g = lib.add({ title: "", text: "x".repeat(100) });
    expect(g.title.length).toBeLessThanOrEqual(60);
    expect(g.title.endsWith("…")).toBe(true);
  });

  it("keeps user-added goals when restoring defaults", () => {
    const file = tempFile();
    const lib = new GoalsLibrary(file);
    lib.add({ title: "My custom goal", text: "do a thing" });
    lib.restoreDefaults();
    expect(lib.all().some((g) => g.title === "My custom goal")).toBe(true);
  });
});
