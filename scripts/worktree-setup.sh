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

name=$(sh scripts/worktree-name.sh --branch)

# --- browser runtime: clone it from a checkout that already has one --------
#
# Which checkout? A linked worktree shares its git dir with the one it was made
# from, so that is the obvious donor. A plain clone beside the others shares
# nothing — its git-common-dir is its own — so there is nobody to ask but the
# siblings themselves.
#
# Whichever it is, the donor has to have been built from OUR pins. A runtime is
# only valid for the lock file it was built from (build-browser-runtime.mjs
# stamps it with exactly these two files), and a runtime copied across a pin
# change is the quiet kind of broken: every path still resolves, the wrong
# versions run.
self=$(pwd -P)
donor=""
for candidate in "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")" ../*; do
  [[ -d "$candidate" ]] || continue
  candidate=$(cd "$candidate" && pwd -P)
  [[ "$candidate" != "$self" ]] || continue
  [[ -d "$candidate/vendor/python-runtime" ]] || continue
  cmp -s "$candidate/vendor/browser-server/runtime.lock.json" vendor/browser-server/runtime.lock.json || continue
  cmp -s "$candidate/vendor/browser-server/requirements.txt" vendor/browser-server/requirements.txt || continue
  donor=$candidate
  break
done

echo "checkout: $name"
echo "donor:    ${donor:-none nearby has a runtime built from these pins}"

for dir in vendor/python-runtime vendor/camoufox-browser vendor/downloads vendor/vault-server vendor/vault-cli; do
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
echo "Checkout '$name' is ready."
echo "  run the suite:   just test"
echo "  launch the app:  just app     (state in \"~/Library/Application Support/Plow-Latch-$name\";"
echo "                                 first launch opens sign-in — this"
echo "                                 checkout needs its own relay credential)"
