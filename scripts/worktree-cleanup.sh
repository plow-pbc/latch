#!/bin/bash
# scripts/worktree-cleanup.sh — the mirror of worktree-setup.sh: remove the
# per-branch state a worktree accumulated OUTSIDE its checkout directory.
# Run it just before the worktree is archived/removed; everything inside the
# checkout (node_modules, dist, the cloned vendor/ runtime) goes away with the
# directory itself and needs no help here.
#
# What it removes (all keyed on the normalized branch name):
#   ~/Library/Application Support/Domo-<branch>          (via `just clean`)
#   ~/Library/Application Support/Domo-<branch>-local    (the DOMO_API_BASE_URL home)
#   /tmp/domo-<branch>                                   (evidence screenshots)
#
# What it cannot do: revoke this worktree's relay credential. Sign-out only
# forgets the credential locally — revocation needs the account's own key
# list, which this Mac deliberately cannot reach (apps/desktop/src/main.ts).
# Deleting the home orphans the device registration on the relay; retire it
# from the account console if it matters.
set -euo pipefail
cd "$(dirname "$0")/.."

# Worktrees only. On the main checkout `just clean` would wipe Domo-main —
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

# The production-facing home ("Domo-<branch>"). Unset the overrides so `clean`
# resolves to this branch's default home, not wherever the caller's
# environment happens to point.
DOMO_HOME= DOMO_API_BASE_URL= just clean

# The local-relay home ("Domo-<branch>-local") and the screenshot dir.
rm -rf "$appsupport/Domo-$branch-local"
rm -rf "/tmp/domo-$branch"
echo "wiped $appsupport/Domo-$branch-local"
echo "wiped /tmp/domo-$branch"

echo ""
echo "Worktree '$name' state is gone. If this worktree had signed in, its"
echo "relay credential is now orphaned — revoke the device from the account"
echo "console if you want it retired server-side."
