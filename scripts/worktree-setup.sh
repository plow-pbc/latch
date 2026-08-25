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
# Per-checkout isolation is handled by the justfile and the app, keyed on the
# normalized branch name (scripts/worktree-name.sh) — for EVERY checkout, the
# main one included; only the packaged install uses the unsuffixed defaults:
#
#   app home          ~/Library/Application Support/Plow-Latch-<branch>
#   local-relay home  ~/Library/Application Support/Plow-Latch-<branch>-local
#   Electron userData inside the home (<home>/electron) — one folder per instance
#   screenshots       /tmp/plow-latch-<branch>                    (main: /tmp)
#
# What is deliberately NOT copied: settings.json and the relay credential in
# it. The relay does not support two devices on one credential, so the first
# `just app` in a new checkout opens sign-in and it gets its own.
# `just package` stays main-only (shared electron-builder caches + keychain).
set -euo pipefail
cd "$(dirname "$0")/.."

checkout=$(sh scripts/worktree-name.sh --branch)

# --- browser runtime: clone it from a checkout that already has one --------
# Which one, and why that one, is runtime-donor.sh's whole job; empty means
# nothing nearby qualifies.
donor=$(sh scripts/runtime-donor.sh)

echo "checkout: $checkout"
echo "donor:    ${donor:-none nearby has a runtime built from these pins}"

# The payloads runtime-donor.sh gates on, which owns that list, plus the
# download cache — a donor without the cache still qualifies, so it is named
# here and not there. A donor may be carrying only some of these (see the
# script's fallback), which is why each dir reports for itself below.
#
# Bound to a variable rather than substituted straight into the `for` word
# list, where neither a non-zero exit nor empty output is examined: this loop
# copying nothing at all, silently, is the failure this whole script is here to
# stop happening. Both halves report — errexit would take the non-zero one on
# its own, but it exits without printing anything, which is the same silence.
payloads=$(sh scripts/runtime-donor.sh --payloads) && [[ -n "$payloads" ]] || {
  echo "error: runtime-donor.sh --payloads failed or named nothing" >&2
  exit 1
}

for payload in $payloads downloads; do
  dir="vendor/$payload"
  if [[ -e "$dir" ]]; then
    echo "$dir already present — leaving it alone"
  elif [[ -n "$donor" && -d "$donor/$dir" ]]; then
    echo "cloning $dir from the donor…"
    # -c uses APFS clonefile; fall back to a plain copy on other filesystems.
    cp -Rpc "$donor/$dir" "$dir" 2>/dev/null || cp -Rp "$donor/$dir" "$dir"
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
echo "  launch the app:  just app     (state in \"~/Library/Application Support/Plow-Latch-$checkout\";"
echo "                                 first launch opens sign-in — this"
echo "                                 checkout needs its own relay credential)"
