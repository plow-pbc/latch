#!/bin/sh
# Prints this checkout's branch name, normalized for use in filesystem paths.
#
# Two modes:
#   (no args)   Prints the name only when the checkout is a linked git
#               worktree; prints nothing (and exits 0) in the main checkout or
#               outside a git repository. "No output" is how worktree-setup.sh
#               knows it is on main.
#   --branch    Prints the name in ANY checkout, main included. This keys the
#               per-branch dev state (app home ~/Library/Application
#               Support/Plow-Latch-<branch>, Electron userData suffix), so every
#               from-source run is isolated from every other and from the
#               packaged install's unsuffixed "Plow-Latch" home.
#
# Normalization: any byte outside [A-Za-z0-9._-] becomes "-", runs collapse,
# and leading dots/dashes are stripped, so "feature/foo bar" -> "feature-foo-bar".
mode=${1:-}
gitdir=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null) || exit 0
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
[ "$gitdir" = "$common" ] && [ "$mode" != "--branch" ] && exit 0

branch=$(git branch --show-current 2>/dev/null)
if [ -z "$branch" ]; then
  # Detached HEAD — fall back to the worktree directory's name.
  branch=$(basename "$(git rev-parse --show-toplevel)")
fi

name=$(printf '%s\n' "$branch" | sed -e 's/[^A-Za-z0-9._-]/-/g' -e 's/--*/-/g' -e 's/^[.-]*//' -e 's/-*$//')
# A branch whose name normalizes to nothing must still not fall through to the
# main checkout's shared state.
[ -n "$name" ] || name=worktree
printf '%s\n' "$name"
