/**
 * Whether a vendored CLI already on disk is the pinned one.
 *
 * Its own module so `fetch-vendored.mjs` can be a pure script — top-level code,
 * nothing exported, nothing importing it. It used to export these, which forced
 * a run-only-if-invoked-directly guard around the CLI, and that guard compared
 * a resolved path against a realpath: through any symlinked path component the
 * two differed and the fetcher became a silent exit-0 no-op. No exports, no
 * guard, no such failure.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The directory every provider's payload lives under, in both trees.
 *
 * The namespace is what makes the packaging sites provider-INDEPENDENT: one
 * `extraResources` entry, one arch glob, one ignore line and one worktree entry
 * cover every present and future provider, so adding one edits none of them.
 * Before this they were four literals per provider, kept in step by a test.
 */
export const PROVIDER_ROOT = "providers";

/**
 * The staleness marker's filename.
 *
 * The fetcher writes it and `isStaged` reads it, both from here.
 * `electron-builder.yml`'s exclude filter is a third spelling that YAML
 * cannot import and NOTHING checks against this one — the test that did was
 * deleted with the packaging fence. Renaming this leaves that filter excluding
 * a file that no longer exists, and the new marker shipping into Resources.
 */
export const MARKER = "VERSION";

/** The staged binary's path, and whether its bytes are the pinned ones. */
export function stagedBinary(provider, arch, root) {
  const file = path.join(root, "vendor", PROVIDER_ROOT, provider.command, arch, provider.command);
  if (!existsSync(file)) return { file, ok: false };
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  return { file, ok: actual === provider.arches[arch].binary, actual };
}

/**
 * Whether the tree already carries this pin, so `package` can depend on the
 * fetch without paying a download every build.
 *
 * CONTENT, not existence. Existence plus a size matched afterPack's gate and
 * nothing else: a cached binary modified by anything with write access to the
 * checkout carried the current marker, skipped the fetch, and went on to be
 * signed and to receive minted tokens. The hash subsumes the size check, and
 * covers the case the skip exists for — a tree where one arch is missing.
 *
 * The marker alone is not enough either: it attests a version, not any bytes.
 */
export function isStaged(provider, root) {
  const marker = path.join(root, "vendor", PROVIDER_ROOT, provider.command, MARKER);
  if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== provider.version) return false;
  return Object.keys(provider.arches).every((arch) => stagedBinary(provider, arch, root).ok);
}
