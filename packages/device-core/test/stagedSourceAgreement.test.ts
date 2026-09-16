/**
 * afterPack.cjs's `bare()` and registry.ts's `sourceStaged()` answer the same
 * question from two different runtimes (CommonJS build tooling vs the ESM
 * package the device serves from): is a plugin's source tree actually
 * staged, or just an empty directory / a tree hollowed to symlinks that a
 * partial stage left behind? This pins their verdicts together on identical
 * tree shapes so the two can't drift back apart.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { sourceStaged } from "../src/plugins/registry.js";
import { tempDirs } from "./pluginFixtures.js";

const bare = createRequire(import.meta.url)("../../../apps/desktop/build/afterPack.cjs").bare as (
  dir: string,
) => boolean;

const { tmp, cleanup } = tempDirs("latch-agree-");
afterEach(() => cleanup());

describe("bare() and sourceStaged() agree on what counts as a staged source tree", () => {
  it("reads a missing directory as NOT staged on both sides", () => {
    const dir = path.join(tmp(), "never-created");
    expect(bare(dir)).toBe(true);
    expect(sourceStaged(dir)).toBe(false);
  });

  it("reads a tree of only empty directories as NOT staged on both sides", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    expect(bare(dir)).toBe(true);
    expect(sourceStaged(dir)).toBe(false);
  });

  it("reads a tree whose only entries are symlinks as NOT staged on both sides", () => {
    const dir = tmp();
    const target = path.join(tmp(), "elsewhere.txt");
    fs.writeFileSync(target, "real content, elsewhere");
    fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
    fs.symlinkSync(target, path.join(dir, "link"));
    fs.symlinkSync(target, path.join(dir, "nested", "link"));
    expect(bare(dir)).toBe(true);
    expect(sourceStaged(dir)).toBe(false);
  });

  it("reads a tree with one real file, nested under empty dirs and alongside symlinks, as staged on both sides", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "empty"), { recursive: true });
    const nested = path.join(dir, "nested");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "real.txt"), "content");
    const target = path.join(tmp(), "elsewhere2.txt");
    fs.writeFileSync(target, "real content, elsewhere");
    fs.symlinkSync(target, path.join(dir, "link"));
    expect(bare(dir)).toBe(false);
    expect(sourceStaged(dir)).toBe(true);
  });
});
