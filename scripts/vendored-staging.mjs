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
 * The staleness marker's filename.
 *
 * The fetcher writes it and `isStaged` reads it, both from here.
 * `electron-builder.yml` carries the literal a third time and cannot import it
 * — what this buys is that the test asserting that filter derives its
 * expectation from here, so a rename fails rather than leaving a green test
 * demanding a filter for a file that no longer exists.
 */
export const MARKER = "VERSION";

/** The staged binary's path, and whether its bytes are the pinned ones. */
export function stagedBinary(provider, arch, root) {
  const file = path.join(root, "vendor", provider.command, arch, provider.command);
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
  const marker = path.join(root, "vendor", provider.command, MARKER);
  if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== provider.version) return false;
  return Object.keys(provider.arches).every((arch) => stagedBinary(provider, arch, root).ok);
}
