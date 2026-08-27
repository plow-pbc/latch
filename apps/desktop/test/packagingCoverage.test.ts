/**
 * Four sites still name each vendored provider by hand: the packaging config's
 * `extraResources` and its `x64ArchFiles` glob, `.gitignore`, and the worktree
 * setup script's clone list. Generating them from the manifest was considered
 * and rejected — a computed electron-builder config is only provable by a real
 * `just package`, which is slow, signing-dependent, and outside this suite,
 * whereas a static config is diffable and survives every refactor of the code
 * that would have generated it.
 *
 * This is the trade that makes leaving them literal safe. Forgetting one is a
 * named failure in milliseconds rather than a shipped app missing a provider's
 * tools for one arch, or a ~13 MB binary committed to git. Provider #2's
 * packaging checklist is "run the suite and fix what it names".
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
// @ts-expect-error — a build-time .mjs with no type declarations.
import { VENDORED } from "../../../scripts/vendored-providers.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

const COMMANDS: string[] = VENDORED.map((p: { command: string }) => p.command);

const builder = parse(read("apps/desktop/electron-builder.yml")) as {
  extraResources: { from: string; to: string }[];
  mac: { x64ArchFiles: string };
};

describe.each(COMMANDS)("packaging covers %s", (command) => {
  it("copies its vendor tree into Resources", () => {
    // Without this the packaged app carries no binary at all, and afterPack's
    // gate is what catches it — at the end of a full package run, not here.
    const entry = builder.extraResources.find((r) => r.to === command);
    expect(entry, `no extraResources entry with \`to: ${command}\``).toBeDefined();
    expect(entry!.from).toBe(`../../vendor/${command}`);
  });

  it("is passed through the universal merge rather than lipo'd", () => {
    // Two THIN per-arch binaries are copied identically into both electron
    // slices, so the merger would try to lipo a thin binary against its
    // identical twin and fail. x64ArchFiles is what passes them through.
    expect(builder.mac.x64ArchFiles).toContain(command);
  });

  it("keeps its vendor tree out of git", () => {
    // Otherwise a multi-megabyte binary lands in a commit, and the pin stops
    // being the only thing deciding what ships.
    expect(read(".gitignore")).toContain(`vendor/${command}/`);
  });

  it("is cloned into a new worktree", () => {
    // Otherwise every new checkout re-downloads it, or runs without it.
    expect(read("scripts/worktree-setup.sh")).toContain(`vendor/${command}`);
  });
});
