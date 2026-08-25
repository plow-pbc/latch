#!/bin/bash
# scripts/worktree-setup.sh — everything needed to make a second checkout
# buildable and runnable alongside the ones already here:
#
#   1. copies the gitignored browser runtime (Python + Camoufox + download
#      cache + vault server/CLI payloads, ~500 MB+) from a checkout that
#      already has one instead of re-downloading or recompiling it (APFS
#      clones, so it is instant and costs no disk on the same volume)
#   2. installs workspace dependencies and builds everything
#
# Works in any checkout — a linked worktree or a plain clone beside the others.
# Nothing here is worktree-specific except where the donor is found, and that
# now falls back to the siblings.
#
# State is keyed on the normalized BRANCH name (scripts/worktree-name.sh) — for
# EVERY checkout, the main one included; only the packaged install uses the
# unsuffixed defaults. Two plain clones on one branch therefore share all of it
# (see CLAUDE.md); only a linked worktree is guaranteed a branch to itself:
#
#   app home          ~/Library/Application Support/Plow-Latch-<branch>
#   local-relay home  ~/Library/Application Support/Plow-Latch-<branch>-local
#   Electron userData inside the home (<home>/electron) — one folder per instance
#   screenshots       /tmp/plow-latch-<branch>                    (main: /tmp)
#
# What is deliberately NOT copied: settings.json and the relay credential in
# it. A checkout whose branch is its own gets its own credential on first
# `just app`; one sharing a branch inherits the home above, credential and all,
# which is why that case wants its own DOMO_HOME.
# `just package` stays main-only (shared electron-builder caches + keychain).
set -euo pipefail
cd "$(dirname "$0")/.."

checkout=$(sh scripts/worktree-name.sh --branch)

# --- browser runtime: clone it from a checkout that already has one --------
# Which one, and why that one, is runtime-donor.sh's whole job; empty means
# nothing nearby qualifies, which is the ordinary answer and not an error.
donor=$(sh scripts/runtime-donor.sh)

echo "checkout: $checkout"
echo "donor:    ${donor:-none nearby has a runtime built from these pins}"

# The payloads runtime-donor.sh gates on, which owns that list, plus the
# download cache — a donor without the cache still qualifies, so it is named
# here and not there. A donor may be carrying only some of these (see the
# script's fallback), which is why each dir reports for itself below.
payloads=$(sh scripts/runtime-donor.sh --payloads)

for payload in $payloads downloads; do
  dir="vendor/$payload"
  if [[ -e "$dir" ]]; then
    echo "$dir already present — leaving it alone"
  elif [[ -n "$donor" && -d "$donor/$dir" ]]; then
    echo "cloning $dir from the donor…"
    # Into a sibling, then renamed into place: a copy interrupted half-way
    # (^C, a full disk) would otherwise leave a partial payload that the
    # `already present` arm above preserves forever — setup would report the
    # checkout ready over a runtime that is missing most of itself. rename(2)
    # is atomic, so the destination either does not exist or is complete.
    # -c uses APFS clonefile; fall back to a plain copy on other filesystems.
    # Cleared before EACH attempt: on a non-APFS volume the clone copy fails
    # part-written, and a fallback into what it left behind nests the payload a
    # directory deeper instead of replacing it.
    rm -rf "$dir.partial"
    cp -Rpc "$donor/$dir" "$dir.partial" 2>/dev/null || {
      rm -rf "$dir.partial"
      cp -Rp "$donor/$dir" "$dir.partial"
    }
    mv "$dir.partial" "$dir"
  else
    echo "note: no $dir to clone — run \`just fetch-browser-runtime fetch-browser\` if you need the browser stack"
  fi
done

# --- deps + build ----------------------------------------------------------
just install
just build

echo ""
echo "Checkout '$checkout' is ready."
echo "  run the suite:   just test"
echo "  launch the app:  just app     (state in \"~/Library/Application Support/Plow-Latch-$checkout\")"
echo ""
# The home is keyed on the branch, and only a linked worktree is guaranteed to
# have that to itself. Say so here rather than promising a per-checkout
# credential the key cannot deliver — see CLAUDE.md.
echo "That home is keyed on the BRANCH, not this directory. Another checkout on"
echo "'$checkout' shares it — same relay credential, identity and audit log."
echo "Set DOMO_HOME, or use another branch, before running both."
