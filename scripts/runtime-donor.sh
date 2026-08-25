#!/bin/sh
# Prints the path of a nearby checkout this one can copy its browser runtime
# from, or nothing (exit 0) when there is none. "No output" is how
# worktree-setup.sh knows to tell the owner to fetch one instead.
#
#   (no args)    the donor's path, or nothing
#   --payloads   the vendor/ dirs a complete donor carries, one per line. One
#                owner for the list: worktree-setup.sh copies these (plus its
#                download cache) and the suite reads them, so a payload added
#                to the build only has to be named here. Reading rather than
#                restating means the suite follows this list wherever it goes,
#                so it names the two load-bearing members once to catch a list
#                that loses one.
#
# Where to look. A linked worktree shares its git dir with the checkout it was
# made from, so that one is the obvious donor. A plain clone beside the others
# shares nothing — its git-common-dir is its own — so there is nobody to ask but
# the siblings themselves. Both are tried, in that order.
#
# What qualifies. The donor must declare OUR pins: a runtime is only valid for
# the lock file it was built from, and one copied across a pin change is the
# quiet kind of broken — every path still resolves, the wrong versions run.
#
# Comparing the two pin files is not the whole story, and deliberately so. The
# build's own stamp covers a third input (PRUNE_VERSION, in
# build-browser-runtime.mjs), so a donor that pulled a pin bump without
# re-running `just fetch-browser` still declares pins it has not built. Nothing
# downstream re-checks: worktree-setup.sh runs install and build, never a fetch.
# Comparing stamps outright would catch it, at the cost of a `--print-stamp`
# flag on the build script and synthetic stamps through both suites — not worth
# it while the failure is a version mismatch that surfaces on use rather than a
# silent wrong answer. What IS caught: a donor pinning something else entirely,
# and (via the stamp's existence) one interrupted mid-fetch.
payloads() {
  printf '%s\n' python-runtime camoufox-browser vault-server vault-cli
}

if [ "${1:-}" = "--payloads" ]; then
  payloads
  exit 0
fi

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
self=$(cd "$root" && pwd -P)

# Complete first, then the Python runtime alone. A donor carrying only what
# `just fetch-browser-runtime` builds cannot give this checkout a browser or a
# vault, so it must never beat a complete one next door — but it is still worth
# taking when nothing complete is nearby: it is the ~5 min, ~200 MB half of the
# fetch, its stamp comes with it, and the copy loop already reports per dir what
# did not come across. Refusing it would cost that rebuild and change nothing
# else.
for required in "$(payloads | tr '\n' ' ')" "python-runtime"; do
  for candidate in "$(dirname "$common")" "$(dirname "$self")"/*; do
    [ -d "$candidate" ] || continue
    # A sibling that cannot be entered is one more unsuitable candidate, not a
    # reason to stop looking.
    candidate=$(cd "$candidate" 2>/dev/null && pwd -P) || continue
    # Ourselves: the git-common-dir of a plain clone is its own, so this is the
    # ordinary case rather than a corner one.
    [ "$candidate" != "$self" ] || continue
    for payload in $required; do
      [ -d "$candidate/vendor/$payload" ] || continue 2
    done
    # A payload directory exists from the moment a fetch starts extracting into
    # it. build-browser-runtime.mjs writes this stamp last, after the build it
    # describes finished, so it separates a donor from a neighbour mid-fetch.
    [ -f "$candidate/vendor/python-runtime/.stamp" ] || continue
    cmp -s "$candidate/vendor/browser-server/runtime.lock.json" \
      "$self/vendor/browser-server/runtime.lock.json" || continue
    cmp -s "$candidate/vendor/browser-server/requirements.txt" \
      "$self/vendor/browser-server/requirements.txt" || continue
    printf '%s\n' "$candidate"
    exit 0
  done
done

# Finding nobody is the ordinary answer in a fresh clone, not a failure — and
# worktree-setup.sh reads this under `set -e`, so leaving the status to whatever
# the loops happened to end on is a trap for the next guard added above.
exit 0
