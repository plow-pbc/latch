#!/bin/bash
# scripts/worktree-cleanup.sh — the mirror of worktree-setup.sh: remove the
# per-branch state a worktree accumulated OUTSIDE its checkout directory.
# Run it just before the worktree is archived/removed; everything inside the
# checkout (node_modules, dist, the cloned vendor/ runtime) goes away with the
# directory itself and needs no help here.
#
# What it removes (all keyed on the normalized branch name):
#   ~/Library/Application Support/Plow-Latch-<branch>        (via `just clean`)
#   ~/Library/Application Support/Plow-Latch-<branch>-local  (the DOMO_API_BASE_URL home)
#   ~/Library/Application Support/Domo-<branch>{,-local}    (pre-rename homes the
#                                                            app never migrated)
#   /tmp/plow-latch-<branch> (and pre-rename /tmp/domo-<branch>)  (evidence screenshots)
#
set -euo pipefail
cd "$(dirname "$0")/.."

# Worktrees only. On the main checkout `just clean` would wipe Plow-Latch-main —
# the main checkout's identity, rules, audit log and relay credential.
name=$(sh scripts/worktree-name.sh)
if [[ -z "$name" ]]; then
  echo "error: this is the main checkout (or not a git worktree) — refusing to wipe its state." >&2
  echo "Run this from a checkout created with \`git worktree add\`." >&2
  exit 1
fi

branch=$(sh scripts/worktree-name.sh --branch)
appsupport="$HOME/Library/Application Support"
echo "cleaning up worktree '$name'…"

# Check every settings-bearing home before deleting any of them. A pending
# token is the only way an offline sign-out can finish revoking its session.
node scripts/assert-home-cleanable.mjs \
  "$appsupport/Plow-Latch-$branch" \
  "$appsupport/Plow-Latch-$branch-local" \
  "$appsupport/Domo-$branch" \
  "$appsupport/Domo-$branch-local"

# The production-facing home ("Plow-Latch-<branch>"). Unset the overrides so
# `clean` resolves to this branch's default home, not wherever the caller's
# environment happens to point.
DOMO_HOME= DOMO_API_BASE_URL= just clean

# The local-relay home ("Plow-Latch-<branch>-local"), the pre-rename "Domo…"
# homes (still there if the app never ran to migrate them), and the
# screenshot dir.
rm -rf "$appsupport/Plow-Latch-$branch-local"
rm -rf "$appsupport/Domo-$branch" "$appsupport/Domo-$branch-local"
rm -rf "/tmp/plow-latch-$branch" "/tmp/domo-$branch"
echo "wiped $appsupport/Plow-Latch-$branch-local"
echo "wiped /tmp/plow-latch-$branch"

echo ""
echo "Worktree '$name' state is gone."
