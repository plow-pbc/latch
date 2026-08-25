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
# What qualifies. The donor must declare OUR pins: a runtime is only valid for
# the lock file it was built from, and one copied across a pin change is the
# quiet kind of broken — every path still resolves, the wrong versions run.
#
# Comparing the two pin files is not the whole story, and deliberately so. The
# build's own stamp covers a third input (PRUNE_VERSION, in
# build-browser-runtime.mjs), and a donor that pulled a pin bump without
# re-running `just fetch-browser-runtime` still declares pins it has not built
# yet. What is left uncaught is a stale donor, which the next fetch rebuilds;
# what is caught is the one that costs a debugging session, a donor from a
# checkout pinning something else entirely.
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
self=$(cd "$root" && pwd -P)

for candidate in "$(dirname "$common")" "$(dirname "$self")"/*; do
  [ -d "$candidate" ] || continue
  # A sibling that cannot be entered is one more unsuitable candidate, not a
  # reason to stop looking.
  candidate=$(cd "$candidate" 2>/dev/null && pwd -P) || continue
  # Ourselves: the git-common-dir of a plain clone is its own, so this is the
  # ordinary case rather than a corner one.
  [ "$candidate" != "$self" ] || continue
  # Every payload, not just the Python one. `just fetch-browser-runtime` builds
  # that dir alone; camoufox, the vault server and the vault CLI only appear
  # under `--browser`. A donor carrying the first would win the search and hand
  # the new checkout a Python runtime with no browser and no vault behind it —
  # the exact state this script exists to prevent.
  #
  # worktree-setup.sh copies these four and vendor/downloads, which is a
  # download cache rather than a payload and so is deliberately not gated on
  # here — a donor without it is still a good donor. Anything added there that
  # the app actually needs belongs in this list too.
  for payload in python-runtime camoufox-browser vault-server vault-cli; do
    [ -d "$candidate/vendor/$payload" ] || continue 2
  done
  cmp -s "$candidate/vendor/browser-server/runtime.lock.json" \
    "$self/vendor/browser-server/runtime.lock.json" || continue
  cmp -s "$candidate/vendor/browser-server/requirements.txt" \
    "$self/vendor/browser-server/requirements.txt" || continue
  printf '%s\n' "$candidate"
  exit 0
done

# Finding nobody is the ordinary answer in a fresh clone, not a failure — and
# worktree-setup.sh reads this under `set -e`, so leaving the status to whatever
# the loop happened to end on is a trap for the next guard added above.
exit 0
