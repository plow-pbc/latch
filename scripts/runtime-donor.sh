#!/bin/sh
# Prints the path of a nearby checkout this one can copy its browser runtime
# from, or nothing (exit 0) when there is none. "No output" is how
# worktree-setup.sh knows to tell the owner to fetch one instead.
#
# Where to look. A linked worktree shares its git dir with the checkout it was
# made from, so that one is the obvious donor. A plain clone beside the others
# shares nothing — its git-common-dir is its own — so there is nobody to ask but
# the siblings themselves. Both are tried, in that order.
#
# What qualifies. The donor must have been built from OUR pins. A runtime is
# only valid for the lock file it was built from — build-browser-runtime.mjs
# stamps it with exactly these two files — and one copied across a pin change is
# the quiet kind of broken: every path still resolves, the wrong versions run.
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
self=$(cd "$root" && pwd -P)

for candidate in "$(dirname "$common")" "$(dirname "$self")"/*; do
  [ -d "$candidate" ] || continue
  candidate=$(cd "$candidate" && pwd -P) || continue
  # Ourselves: the git-common-dir of a plain clone is its own, so this is the
  # ordinary case rather than a corner one.
  [ "$candidate" != "$self" ] || continue
  [ -d "$candidate/vendor/python-runtime" ] || continue
  cmp -s "$candidate/vendor/browser-server/runtime.lock.json" \
    "$self/vendor/browser-server/runtime.lock.json" || continue
  cmp -s "$candidate/vendor/browser-server/requirements.txt" \
    "$self/vendor/browser-server/requirements.txt" || continue
  printf '%s\n' "$candidate"
  exit 0
done
