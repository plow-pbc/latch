#!/bin/bash
# scripts/worktree-setup.sh — everything needed after `git worktree add` to
# make the new checkout buildable and runnable alongside the main checkout:
#
#   1. copies the gitignored browser runtime (Camoufox tree + download cache +
#      the frozen fingerprint pool, ~350 MB) from the main checkout instead of
#      re-downloading it (APFS clones, so it is instant and costs no disk on the
#      same volume). No Python: the browser server is TypeScript.
#   2. installs workspace dependencies and builds everything
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
# `just app` in a worktree opens sign-in and the worktree gets its own.
# `just package` runs here too, into this checkout's apps/desktop/release/ —
# just not concurrently with another checkout (shared electron-builder caches
# + keychain).
set -euo pipefail
cd "$(dirname "$0")/.."

name=$(sh scripts/worktree-name.sh)
if [[ -z "$name" ]]; then
  echo "error: this is the main checkout (or not a git worktree) — nothing to set up." >&2
  echo "Run this from a checkout created with \`git worktree add\`." >&2
  exit 1
fi

main_root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
echo "worktree:      $name"
echo "main checkout: $main_root"

# --- browser runtime: clone from the main checkout -------------------------
# The Camoufox tree and the frozen fingerprint pool are BOTH required for a ready
# browser stack — browserRuntime.ts refuses to offer browsing without either, so
# the pool (packages/browser-server/fingerprints.json, gitignored build output)
# is cloned alongside the browser, not left for a launch to discover missing.
for dir in vendor/camoufox-browser vendor/downloads vendor/providers packages/browser-server/fingerprints.json; do
  if [[ -e "$dir" ]]; then
    echo "$dir already present — leaving it alone"
  elif [[ -e "$main_root/$dir" ]]; then
    echo "cloning $dir from the main checkout…"
    # -c uses APFS clonefile; fall back to a plain copy on other filesystems.
    cp -Rpc "$main_root/$dir" "$dir" 2>/dev/null || cp -Rp "$main_root/$dir" "$dir"
  else
    echo "note: $main_root/$dir does not exist — skipping (run \`just fetch-browser\` later if you need the browser stack)"
  fi
done

# --- deps + build ----------------------------------------------------------
just install
just build

echo ""
echo "Worktree '$name' is ready."
echo "  run the suite:   just test"
echo "  launch the app:  just app     (state in \"~/Library/Application Support/Plow-Latch-$name\";"
echo "                                 first launch opens sign-in — this"
echo "                                 worktree needs its own relay credential)"
