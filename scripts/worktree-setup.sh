#!/bin/bash
# scripts/worktree-setup.sh — everything needed after `git worktree add` to
# make the new checkout buildable and runnable alongside the main checkout:
#
#   1. copies the gitignored payloads — the browser runtime (Python + Camoufox
#      + download cache + vault server/CLI, ~500 MB+) and the vendored provider
#      CLIs (vendor/providers) — from a checkout that already has them, instead
#      of re-downloading or recompiling them (APFS clones, so it is instant and
#      costs no disk on the same volume)
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
# `just package` stays main-only (shared electron-builder caches + keychain).
set -euo pipefail
cd "$(dirname "$0")/.."

name=$(sh scripts/worktree-name.sh)
if [[ -z "$name" ]]; then
  echo "error: this is the main checkout (or not a git worktree) — nothing to set up." >&2
  echo "Run this from a checkout created with \`git worktree add\`." >&2
  exit 1
fi

self=$(pwd -P)
# ONE checkout supplies the payloads, and it is the one on `main`.
#
# Which checkout matters, because these are BUILD INPUTS: a feature worktree's
# `vendor/` is whatever that branch's pin last fetched, so taking each payload
# from the first checkout that happened to have it could assemble a runtime out
# of two branches' pins — a mix nobody has ever run, and a bug report nobody can
# reproduce.
#
# `main` first, then the classic layout's root (`<root>/.git` -> `<root>`),
# which IS the main checkout there. Under the bare layout this repo uses
# (`<container>/.bare` -> `<container>`) that path is the container, holds no
# `vendor/` at all, and every payload was silently skipped — which is the bug
# this fixes.
primary=$(git worktree list --porcelain |
  awk '/^worktree /{p=substr($0,10)} /^branch refs\/heads\/main$/{print p; exit}')
if [[ -z "$primary" ]]; then
  primary=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
  echo "note: no checkout is on main — falling back to $primary"
fi

echo "worktree:      $name"
echo "payload source: $primary"

# --- gitignored payloads: clone them from that ONE checkout ----------------
# The browser runtime (Python + Camoufox + download cache + vault server/CLI)
# and the vendored provider CLIs alike: both are gitignored, both are expensive
# to fetch again, and both are needed for a from-source run.
for dir in vendor/python-runtime vendor/camoufox-browser vendor/downloads vendor/vault-server vendor/vault-cli vendor/providers; do
  if [[ -e "$dir" ]]; then
    echo "$dir already present — leaving it alone"
    continue
  fi
  source_root=""
  if [[ -d "$primary/$dir" ]]; then
    source_root="$primary"
  else
    # The source of record does not have this one. Falling back is better than
    # sending someone off to re-fetch half a gigabyte, but it is a payload from
    # ANOTHER branch's pin, so it is announced rather than done quietly.
    # read, not word-splitting a `$(…)`: a checkout path may contain spaces.
    while read -r candidate; do
      [[ -z "$candidate" || "$candidate" == "$self" || "$candidate" == "$primary" ]] && continue
      if [[ -d "$candidate/$dir" ]]; then
        source_root="$candidate"
        echo "note: $primary has no $dir — taking it from $candidate instead (another branch's pin)"
        break
      fi
    done < <(git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}')
  fi
  if [[ -n "$source_root" ]]; then
    # Braced: the ellipsis that follows is not ASCII, and bash reads it as part
    # of an unbraced name.
    echo "cloning $dir from ${source_root}…"
    # -c uses APFS clonefile; fall back to a plain copy on other filesystems.
    cp -Rpc "$source_root/$dir" "$dir" 2>/dev/null || cp -Rp "$source_root/$dir" "$dir"
  else
    echo "note: no checkout has $dir — skipping (run \`just fetch-browser-runtime fetch-browser\` for the browser stack, \`just fetch-vendored\` for the provider CLIs)"
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
