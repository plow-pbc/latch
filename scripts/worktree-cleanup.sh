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
# It cannot revoke anything itself. It does not have to: the app revokes on
# sign-out and retries whatever that could not retire, so a home this script
# will delete is one with nothing left to retire — which is exactly what the
# refusal below checks.
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

# REFUSE while a home still holds ANY live session token.
#
# The credential is the owner's Plow login SESSION now, not a scoped device key
# minted for this checkout — and deleting the file does not retire it. Whatever
# is in there stays live on the account for 180 days of disuse, with nothing
# left on this Mac that could revoke it. So: sign out in the app first (that is
# the only thing that calls `/v1/relay/devices/self/revoke`), then run this.
#
# `pendingRevocations` counts too, and a signed-OUT home is exactly where it
# turns up: it holds sessions the app could not reach Plow to retire, and it is
# the only remaining handle on them. Sign-out does not clear it — deliberately,
# because sign-out's own revoke is what failed — so a refusal that read only
# the credential would wave through the one home whose deletion strands a live
# `*:*` session for good.
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
  # Either field, sealed or not: a home stores a secret in the clear where the
  # OS offered no keychain and sealed where it did. Newlines and spaces come
  # out first, so one expression covers the pretty-printed `pendingRevocations`
  # array as well as the scalar credential; an empty string and an empty list
  # both fail to match, which is what "holds nothing" looks like.
  if tr -d '\n ' < "$settings" \
    | grep -qE '"(relayCredential|pendingRevocations)(Enc)?":("[^"]+"|\["[^"]+")' 2>/dev/null; then
    if [ "${FORCE:-}" = "1" ]; then
      echo "WARNING: $settings still holds a credential; deleting it does NOT revoke the session." >&2
      echo "         Revoke it in Plow, or it stays live on the account." >&2
    else
      echo "refusing: $settings still holds a Plow login session." >&2
      echo "  Sign out in the app first — that revokes it server-side." >&2
      echo "  If you already have, the app is still holding a session it could" >&2
      echo "  not reach Plow to retire; reopen it while online and it retries." >&2
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
echo "Worktree '$name' state is gone."
