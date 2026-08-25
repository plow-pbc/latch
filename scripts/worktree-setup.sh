#!/bin/bash
# scripts/worktree-setup.sh — everything needed after `git worktree add` to
# make the new checkout buildable and runnable alongside the main checkout:
#
#   1. copies the gitignored browser runtime (Python + Camoufox + download
#      cache + vault server/CLI payloads, ~500 MB+) from the main checkout
#      instead of re-downloading or recompiling it (APFS clones, so it is
#      instant and costs no disk on the same volume)
#   2. installs workspace dependencies and builds everything
#   3. copies Electron's prebuilt binary the same way, because `npm install`
#      leaves only a stub of it here (see the step itself for why)
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

# Where the prebuilt, gitignored payloads live. In the classic layout that is
# the directory holding .git, but with a bare repository and sibling worktrees
# that directory holds no checkout at all — the payloads are in whichever
# worktree has `main`. Ask git which one that is, and only fall back to the
# .git-holding directory when no worktree does.
main_root=$(git worktree list --porcelain | awk '
  /^worktree / { wt = substr($0, 10) }
  $0 == "branch refs/heads/main" { print wt; exit }
')
if [[ -z "$main_root" ]]; then
  main_root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
fi
echo "worktree:      $name"
echo "main checkout: $main_root"

# Say so loudly rather than letting every copy below print its own "skipping"
# note: a setup that sourced nothing still exits 0, and the checkout only turns
# out to be unusable later, at launch.
if [[ ! -f "$main_root/package.json" ]]; then
  echo "warning: $main_root is not a checkout of this repo — nothing can be cloned from it." >&2
  echo "         This worktree will need \`just fetch-browser-runtime fetch-browser\` and a" >&2
  echo "         real \`npm install\` of electron before the app will run." >&2
fi

# --- browser runtime: clone from the main checkout -------------------------
for dir in vendor/python-runtime vendor/camoufox-browser vendor/downloads vendor/vault-server vendor/vault-cli; do
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

# --- deps ------------------------------------------------------------------
just install

# --- electron binary: clone from the main checkout -------------------------
# `npm install` does not leave a runnable Electron here: its postinstall, which
# downloads the 242 MB prebuilt dist, is blocked, so node_modules/electron ends
# up with a 256 KB dist and no path.txt. Nothing looks wrong — the package is
# there and node_modules/.bin/electron is a symlink either way — until the app
# launches and `require("electron")` throws "Electron failed to install
# correctly". Clone the dist the same way as the browser runtime.
electron_dir=node_modules/electron
src_electron="$main_root/$electron_dir"
# The binary must match the package that will load it, so compare before
# copying: a dist from a different Electron is a worse failure than no dist.
# `require` resolves a bare relative path as a PACKAGE name, not against the
# working directory, so resolve it first — silently reading no version here is
# how this step skipped itself while reporting success.
electron_version() {
  node -e "process.stdout.write(require(require('path').resolve('$1', 'package.json')).version)" 2>/dev/null || true
}
if [[ ! -d "$electron_dir" ]]; then
  echo "note: $electron_dir is absent — skipping (nothing depends on it in this checkout?)"
elif [[ -s "$electron_dir/path.txt" ]] && [[ -x "$electron_dir/dist/$(cat "$electron_dir/path.txt")" ]]; then
  echo "electron already installed — leaving it alone"
elif [[ ! -f "$src_electron/path.txt" ]]; then
  echo "note: $src_electron has no path.txt either — skipping (run \`npm rebuild electron\` with postinstall scripts allowed)"
elif [[ "$(electron_version "$electron_dir")" != "$(electron_version "$src_electron")" ]]; then
  echo "note: main checkout has electron $(electron_version "$src_electron"), this one wants $(electron_version "$electron_dir") — skipping"
else
  echo "cloning $electron_dir/dist from the main checkout…"
  rm -rf "$electron_dir/dist"
  cp -Rpc "$src_electron/dist" "$electron_dir/dist" 2>/dev/null || cp -Rp "$src_electron/dist" "$electron_dir/dist"
  cp -p "$src_electron/path.txt" "$electron_dir/path.txt"
  # Resolve it the way the app will. `node_modules/.bin/electron` is a symlink
  # that exists whether or not the binary does, so checking it proves nothing;
  # `require("electron")` is the path that actually throws.
  electron_bin=$(node -p 'require("electron")')
  [[ -x "$electron_bin" ]] || { echo "error: require(\"electron\") resolved to $electron_bin, which is not executable" >&2; exit 1; }
  echo "electron ready: $electron_bin"
fi

# --- build -----------------------------------------------------------------
just build

echo ""
echo "Worktree '$name' is ready."
echo "  run the suite:   just test"
echo "  launch the app:  just app     (state in \"~/Library/Application Support/Plow-Latch-$name\";"
echo "                                 first launch opens sign-in — this"
echo "                                 worktree needs its own relay credential)"
