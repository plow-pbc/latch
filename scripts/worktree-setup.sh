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
    # Into a staging sibling, renamed onto `$dir` only once the copy has
    # SUCCEEDED, because the loop above treats existence as completion: a `cp`
    # that died partway (or a run someone interrupted) otherwise left `$dir`
    # there, and the next setup skipped it, built, and reported ready on half a
    # runtime. Unique per run so two setups cannot land in each other's
    # staging; the sweep clears what an interrupted run left, which is inert
    # either way — only `$dir` itself is ever read as "already present".
    rm -rf "$dir".incoming.*
    staging="$dir.incoming.$$"
    # -c uses APFS clonefile; fall back to a plain copy on other filesystems.
    # CLEARED BETWEEN THE TWO: a clone that failed partway leaves a directory
    # behind, and `cp -Rp` onto an existing directory copies the payload INSIDE
    # it — a tree one level too deep, which every later check reads as present.
    if ! cp -Rpc "$primary/$dir" "$staging" 2>/dev/null; then
      rm -rf "$staging"
      if ! cp -Rp "$primary/$dir" "$staging"; then
        rm -rf "$staging"
        echo "error: copying $dir from $primary failed — nothing was left behind." >&2
        exit 1
      fi
    fi
    mv "$staging" "$dir"
  else
    echo "note: $primary/$dir does not exist — skipping (run \`just fetch-browser-runtime fetch-browser\` for the browser stack, \`just fetch-vendored\` for the provider CLIs)"
  fi
done

# --- reconcile the payloads that are PRESENT against this branch's pins -----
# The copy is an optimisation; the pins are the authority. A payload carries the
# SOURCE checkout's bytes, so a branch that bumps a pin would otherwise build,
# test and launch against the old ones while setup reported it ready.
#
# Keyed on what is PRESENT, not on what this run copied: both recipes are
# content-addressed and skip on a match — `isStaged` hashes the staged binary
# against the lock (scripts/vendored-staging.mjs), the browser build stamps
# runtime.lock.json and requirements — so a tree that already agrees costs a
# hash, and a reconcile that failed (or a payload someone copied in by hand)
# is re-checked on the next run rather than being skipped forever. A payload
# that is ABSENT is still not fetched: that would turn a skip note into a cold
# build nobody asked for.
if [[ -d vendor/providers ]]; then
  echo "reconciling vendor/providers against this branch's pins…"
  just fetch-vendored
fi
# `--browser` is a superset of the runtime-only mode — it stamps the Python
# runtime AND checks Camoufox, the vault web UI, the vault CLI and the vault
# server — and it is the ONLY mode that looks at the vault trees at all, so
# anything carrying them goes through it. Runtime-only is kept for a tree that
# has nothing but Python, where `--browser` would fetch a browser nobody copied.
if [[ -d vendor/camoufox-browser || -d vendor/vault-server || -d vendor/vault-cli || -d vendor/downloads ]]; then
  echo "reconciling the browser stack against this branch's pins…"
  node scripts/build-browser-runtime.mjs --browser
elif [[ -d vendor/python-runtime ]]; then
  echo "reconciling the Python runtime against this branch's pins…"
  node scripts/build-browser-runtime.mjs
fi

# --- deps + build ----------------------------------------------------------
just install
just build

echo ""
echo "Worktree '$name' is ready."
echo "  run the suite:   just test"
echo "  launch the app:  just app     (state in \"~/Library/Application Support/Plow-Latch-$name\";"
echo "                                 first launch opens sign-in — this"
echo "                                 worktree needs its own relay credential)"
