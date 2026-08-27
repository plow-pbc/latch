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
 * tools for one arch, or a ~13 MB binary committed to git.
 *
 * Every assertion here is against the thing that actually decides — the glob
 * matched against a real packaged path, the ignore rule asked of git itself,
 * the clone list's own tokens. A substring check reads the
 * same and passes on edits that do not work: adding a provider to the INNER
 * alternation of the arch glob contains its name while matching none of its
 * paths, and a provider named `vault` is a substring of `vault-cli` at once.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minimatch } from "minimatch";
import { parse } from "yaml";
// @ts-expect-error — a build-time .mjs with no type declarations.
import { VENDORED } from "../../../scripts/vendored-providers.mjs";
// @ts-expect-error — a build-time .mjs with no type declarations.
import { MARKER } from "../../../scripts/vendored-staging.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

const PROVIDERS: { command: string; arches: Record<string, unknown> }[] = VENDORED;

const builder = parse(read("apps/desktop/electron-builder.yml")) as {
  extraResources: { from: string; to: string; filter?: string[] }[];
  mac: { x64ArchFiles?: string };
};

/**
 * The clone list `worktree-setup.sh` iterates, as its own tokens.
 *
 * A mention in the header comment or in a `skipping` echo is not a clone, hence
 * parsing the loop rather than the file. The parse assumes one line of literal
 * words, so it is checked for having understood the script at all — a
 * continued list, or one moved into an array, would otherwise yield too few
 * tokens and report every provider as "not cloned" when they all are.
 */
const clonedDirs = (() => {
  const line = read("scripts/worktree-setup.sh")
    .split("\n")
    .find((l) => l.trimStart().startsWith("for dir in "));
  expect(line, "worktree-setup.sh has no `for dir in ...` clone list").toBeDefined();
  const tokens = line!.trim().replace(/^for dir in /, "").replace(/;.*$/, "").split(/\s+/);
  expect(tokens.every((t) => /^vendor\/[\w.-]+$/.test(t)), `clone list not understood: ${line}`).toBe(
    true,
  );
  return tokens;
})();

/**
 * Whether git ignores a path under this provider's vendor tree.
 *
 * Asked of git, which is the thing that actually decides — matching the rest of
 * this file. Parsing `.gitignore` here instead meant re-implementing its
 * grammar badly: a hand-rolled last-match-wins over one exact spelling missed
 * that `/vendor/gog/` and `vendor/gog` are the same pattern, so a later
 * negation written either way left the check green with nothing ignored.
 *
 * `check-ignore` exits 0 when the path is ignored and 1 when it is not.
 */
function ignoresVendorTree(command: string): boolean {
  const { status } = spawnSync("git", ["check-ignore", "-q", `vendor/${command}/probe`], {
    cwd: repoRoot,
  });
  return status === 0;
}

describe.each(PROVIDERS)("packaging covers $command", ({ command, arches }) => {
  const entry = () => builder.extraResources.find((r) => r.to === command);

  it("copies its vendor tree into Resources", () => {
    // Without this the packaged app carries no binary at all, and afterPack's
    // gate is what catches it — at the end of a full package run, not here.
    expect(entry(), `no extraResources entry with \`to: ${command}\``).toBeDefined();
    expect(entry()!.from).toBe(`../../vendor/${command}`);
  });

  it("leaves the fetcher's staleness marker out of the bundle", () => {
    // `VERSION` is local bookkeeping, not payload. The entry the test above
    // demands can be written without a filter, which ships it into signed
    // Resources — the same line and the same forgetting, one field over.
    expect(entry()?.filter ?? []).toContain(`!${MARKER}`);
  });

  it.each(Object.keys(arches))("passes its %s binary through the universal merge", (arch) => {
    // Two THIN per-arch binaries are copied identically into both electron
    // slices, so the merger would try to lipo a thin binary against its
    // identical twin and fail. x64ArchFiles is what passes them through.
    //
    // Matched against the real packaged path with minimatch, as
    // @electron/universal does — though with a different major and without its
    // `matchBase`, so this is a close approximation rather than the merge
    // itself. Both differences make it stricter for the globs in play here, so
    // the risk it carries is a false failure, not a false pass.
    const glob = builder.mac.x64ArchFiles;
    expect(glob, "mac.x64ArchFiles is not set at all").toBeDefined();
    expect(minimatch(`Contents/Resources/${command}/${arch}/${command}`, glob!)).toBe(true);
  });

  it("keeps its vendor tree out of git", () => {
    // Otherwise a multi-megabyte binary lands in a commit, and the pin stops
    // being the only thing deciding what ships. A commented-out or later-negated
    // line reads the same in the file and ignores nothing.
    expect(ignoresVendorTree(command)).toBe(true);
  });

  it("is cloned into a new worktree", () => {
    // Otherwise every new checkout re-downloads it, or runs without it.
    expect(clonedDirs).toContain(`vendor/${command}`);
  });
});
