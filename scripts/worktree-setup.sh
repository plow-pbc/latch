#!/bin/bash
# scripts/worktree-setup.sh — everything needed after `git worktree add` to
# make the new checkout buildable and runnable alongside the main checkout:
#
#   1. copies the gitignored browser runtime (Python + Camoufox + download
#      cache, ~500 MB+) from the main checkout instead of re-downloading it
#      (APFS clones, so it is instant and costs no disk on the same volume)
#   2. installs workspace dependencies and builds everything
#
# Per-worktree isolation is handled by the justfile and the app, keyed on the
# normalized branch name (scripts/worktree-name.sh):
#
#   app home          ~/.domo-worktrees/<branch>            (main: ~/.domo)
#   local-relay home  ~/.domo-worktrees/<branch>-local      (main: ~/.domo-local)
#   Electron userData ~/Library/Application Support/Domo Desktop (<branch>)
#   screenshots       /tmp/domo-<branch>                    (main: /tmp)
#
# What is deliberately NOT copied: settings.json and the relay credential in
# it. The relay does not support two devices on one credential, so the first
# `just app` in a worktree opens sign-in and the worktree gets its own.
# `just package` stays main-only (shared electron-builder caches + keychain).
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
for dir in vendor/python-runtime vendor/camoufox-browser vendor/downloads; do
  if [[ -e "$dir" ]]; then
    echo "$dir already present — leaving it alone"
  elif [[ -d "$main_root/$dir" ]]; then
    echo "cloning $dir from the main checkout…"
    # -c uses APFS clonefile; fall back to a plain copy on other filesystems.
    cp -Rpc "$main_root/$dir" "$dir" 2>/dev/null || cp -Rp "$main_root/$dir" "$dir"
  else
    echo "note: $main_root/$dir does not exist — skipping (run \`just fetch-browser-runtime fetch-browser\` later if you need the browser stack)"
  fi
done

# --- deps + build ----------------------------------------------------------
just install
just build

echo ""
echo "Worktree '$name' is ready."
echo "  run the suite:   just test"
echo "  launch the app:  just app     (state in ~/.domo-worktrees/$name;"
echo "                                 first launch opens sign-in — this"
echo "                                 worktree needs its own relay credential)"
