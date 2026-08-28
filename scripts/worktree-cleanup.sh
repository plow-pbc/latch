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
# What it cannot do: revoke this worktree's relay credential. Sign-out only
# forgets the credential locally — revocation needs the account's own key
# list, which this Mac deliberately cannot reach (apps/desktop/src/main.ts).
# Deleting the home orphans the device registration on the relay; retire it
# from the account console if it matters.
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

# REFUSE while a home still holds a credential.
#
# The credential is the owner's Plow login SESSION now, not a scoped device key
# minted for this checkout — and deleting the file does not retire it. Whatever
# is in there stays live on the account for 180 days of disuse, with nothing
# left on this Mac that could revoke it. So: sign out in the app first (that is
# the only thing that calls `/v1/relay/devices/self/revoke`), then run this.
#
# `--force` is for a home whose session is already dead or deliberately
# abandoned; it says so out loud rather than deleting quietly.
# EVERY home this script deletes, including the pre-rename "Domo…" ones below:
# a home the refusal does not scan is a home whose session it silently takes
# the only means of revoking. The list here and the `rm -rf` list are the same
# list, deliberately.
for home in \
  "$appsupport/Plow-Latch-$branch" \
  "$appsupport/Plow-Latch-$branch-local" \
  "$appsupport/Domo-$branch" \
  "$appsupport/Domo-$branch-local"; do
  settings="$home/app/settings.json"
  [ -f "$settings" ] || continue
  # Either field: an older home stores it in the clear, a newer one sealed.
  if grep -qE '"relayCredential(Enc)?": *"[^"]+"' "$settings" 2>/dev/null; then
    if [ "${FORCE:-}" = "1" ]; then
      echo "WARNING: $settings still holds a credential; deleting it does NOT revoke the session." >&2
      echo "         Revoke it in Plow, or it stays live on the account." >&2
    else
      echo "refusing: $settings still holds a Plow login session." >&2
      echo "  Sign out in the app first — that revokes it server-side." >&2
      echo "  Or re-run with FORCE=1 to delete anyway and revoke it in Plow yourself." >&2
      exit 1
    fi
  fi
done

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
echo "Worktree '$name' state is gone. If this worktree had signed in, its"
echo "relay credential is now orphaned — revoke the device from the account"
echo "console if you want it retired server-side."
