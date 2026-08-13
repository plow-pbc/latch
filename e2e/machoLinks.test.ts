/**
 * The `otool -L` shapes the packaging build has to read correctly. Getting this
 * wrong is not a cosmetic bug: a false positive aborts a release build blaming
 * a library that is fine, and a false negative ships a binary that only fails
 * on a user's Mac.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs, no types, deliberately importable from the build script
import { foreignLinks } from "../scripts/machoLinks.mjs";

const OS_ONLY = `vendor/vault-server/arm64/vaultwarden:
\t/System/Library/Frameworks/Security.framework/Versions/A/Security (compatibility version 1.0.0, current version 61901.120.67)
\t/usr/lib/libiconv.2.dylib (compatibility version 7.0.0, current version 7.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)
`;

const BREWED = OS_ONLY.replace(
  "\t/usr/lib/libiconv.2.dylib",
  "\t/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib (compatibility version 3.0.0, current version 3.0.0)\n\t/usr/lib/libiconv.2.dylib",
);

// Both `bw` binaries are thin today, but they are built by someone else and
// pinned by URL — a universal one would arrive with a header per slice, naming
// the file itself rather than anything it links.
const FAT = `vendor/vault-cli/bw (architecture arm64):
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)
vendor/vault-cli/bw (architecture x86_64):
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)
`;

// The Python relocation step writes these on purpose; calling one foreign would
// abort packaging over a link that resolves inside the bundle.
const RELATIVE = `Python.framework/Versions/3.12/lib/libpython3.12.dylib:
\t@loader_path/../Python (compatibility version 3.12.0, current version 3.12.0)
\t@rpath/libssl.dylib (compatibility version 1.0.0, current version 1.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)
`;

describe("what otool -L says a binary needs", () => {
  it.each([
    ["passes a binary that needs only the OS", OS_ONLY, []],
    ["catches the Homebrew dylib that would have shipped", BREWED, [
      "/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib",
    ]],
    ["ignores a fat binary's own slice headers", FAT, []],
    ["treats loader-relative references as resolved, not missing", RELATIVE, []],
  ])("%s", (_what, output, foreign) => {
    expect(foreignLinks(output)).toEqual(foreign);
  });
});
