#!/bin/bash
# scripts/worktree-setup.sh — everything needed after `git worktree add` to
# make the new checkout buildable and runnable alongside the main checkout:
#
#   1. copies the gitignored payloads — the browser runtime (Python + Camoufox
#      + download cache + vault server/CLI, ~500 MB+) and the vendored provider
#      CLIs (vendor/providers) — from the checkout on `main`, instead of
#      re-downloading or recompiling them (APFS clones, so it is instant and
#      costs no disk on the same volume). `PAYLOAD_SOURCE=<checkout>` clones
#      them from somewhere else instead.
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

# ONE checkout supplies the payloads, and it is the one on `main`.
#
# Which checkout matters, because these are BUILD INPUTS: a feature worktree's
# `vendor/` is whatever that branch's pin last fetched, so drawing payloads
# from whichever checkout happened to have each one could assemble a runtime
# out of two branches' pins — a mix nobody has ever run, and a bug report
# nobody can reproduce. There is deliberately NO automatic fallback: a payload
# the source of record does not have is skipped, and the note says to fetch it.
#
# `PAYLOAD_SOURCE` overrides the choice for ALL payloads at once — the one way
# to clone from somewhere else, spelled out by whoever wants it rather than
# guessed. Named and wrong is fatal: the whole point of this script is that a
# missing payload should not be discovered later, and a typo that silently
# skipped everything is the failure it exists to prevent.
if [[ -n "${PAYLOAD_SOURCE:-}" ]]; then
  if [[ ! -d "$PAYLOAD_SOURCE" ]]; then
    echo "error: PAYLOAD_SOURCE=$PAYLOAD_SOURCE is not a directory." >&2
    exit 1
  fi
  primary=$PAYLOAD_SOURCE
  echo "payload source: $primary (PAYLOAD_SOURCE)"
else
  # `main` first, then the classic layout's root (`<root>/.git` -> `<root>`),
  # which IS the main checkout there. Under the bare layout this repo uses
  # (`<container>/.bare` -> `<container>`) that path is the container, holds no
  # `vendor/` at all, and every payload was silently skipped — the bug this
  # fixes — so when it is what we fall back to, the note says so.
  primary=$(git worktree list --porcelain |
    awk '/^worktree /{p=substr($0,10)} /^branch refs\/heads\/main$/{print p; exit}')
  if [[ -z "$primary" ]]; then
    primary=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
    echo "note: no checkout is on main — falling back to $primary"
    echo "      (set PAYLOAD_SOURCE=<checkout> to clone the payloads from one)"
  fi
  echo "payload source: $primary"
fi

echo "worktree:      $name"

# --- gitignored payloads: clone them from that ONE checkout ----------------
# The browser runtime (Python + Camoufox + download cache + vault server/CLI)
# and the vendored provider CLIs alike: both are gitignored, both are expensive
# to fetch again, and both are needed for a from-source run.
for dir in vendor/python-runtime vendor/camoufox-browser vendor/downloads vendor/vault-server vendor/vault-cli vendor/providers; do
  if [[ -e "$dir" ]]; then
    echo "$dir already present — leaving it alone"
  elif [[ -d "$primary/$dir" ]]; then
    # Braced: the ellipsis that follows is not ASCII, and bash reads it as part
    # of an unbraced name.
    echo "cloning $dir from ${primary}…"
    # -c uses APFS clonefile; fall back to a plain copy on other filesystems.
    cp -Rpc "$primary/$dir" "$dir" 2>/dev/null || cp -Rp "$primary/$dir" "$dir"
  else
    echo "note: $primary/$dir does not exist — skipping (run \`just fetch-browser-runtime fetch-browser\` for the browser stack, \`just fetch-vendored\` for the provider CLIs)"
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
