/**
 * Reading `otool -L`, which is fiddlier than it looks.
 *
 * A thin binary lists its dependencies one per tab-indented line. A fat one
 * repeats the whole block per slice, each introduced by a flush-left
 * `<path> (architecture arm64):` header naming the file itself. And a
 * dependency may be recorded relative to the loader (`@rpath/…`) rather than
 * absolutely.
 *
 * Its own module so those three shapes can be tested — the build script runs
 * its driver at top level and cannot be imported, and no artifact we currently
 * ship exercises the fat or `@rpath` cases.
 */

/**
 * Dependencies that would not resolve on a Mac with nothing installed on it.
 *
 * `@`-relative references are deliberately NOT foreign: they resolve inside the
 * bundle by construction, and the Python payload's relocation step writes them
 * on purpose. Reporting one as "a library no user's Mac has" would abort a
 * packaging run and blame the wrong thing.
 */
export function foreignLinks(otoolOutput) {
  return otoolOutput
    .split("\n")
    .filter((line) => line.startsWith("\t")) // flush-left lines are slice headers
    .map((line) => line.trim().split(" ")[0])
    .filter(
      (p) =>
        p &&
        !p.startsWith("@") &&
        !p.startsWith("/usr/lib/") &&
        !p.startsWith("/System/Library/"),
    );
}
