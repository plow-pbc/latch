#!/bin/sh
# Prints this checkout's branch name, normalized for use in filesystem paths,
# when the checkout is a linked git worktree. Prints nothing (and exits 0) in
# the main checkout or outside a git repository — "no output" is how the
# justfile and worktree-setup.sh know they are on main and should use the
# default per-user state locations (~/.domo, "Domo Desktop", /tmp).
#
# Normalization: any byte outside [A-Za-z0-9._-] becomes "-", runs collapse,
# and leading dots/dashes are stripped, so "feature/foo bar" -> "feature-foo-bar".
gitdir=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null) || exit 0
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
[ "$gitdir" = "$common" ] && exit 0

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
