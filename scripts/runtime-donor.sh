#!/bin/sh
# Which checkout this one may copy its browser runtime from.
#
#   (no args)      the donor this checkout INHERITS — the one a linked worktree
#                  was created out of — or nothing. A plain clone inherits none.
#   --check DIR    exit 0 if DIR is a donor this checkout can use
#   --candidates   nearby checkouts that would qualify, one per line. Advice for
#                  the human choosing one; never a choice this script makes.
#   --payloads     the vendor dirs a complete donor carries, one per line. One
#                  owner for the list: worktree-setup.sh copies these (plus its
#                  download cache) and the suite reads them, so a payload added
#                  to the build only has to be named here.
#
# Why a plain clone has to be told rather than shown. A donor's payloads are
# executed: the bundled Python runs the browser server and vaultwarden is
# spawned, both outside the seatbelt and both with this checkout's vault and
# relay credential within reach. Qualification is cheap to forge — four
# directories and an empty marker file, 8 KB — so choosing a donor by scanning
# whatever sits nearby would let anything able to write ONE checkout put code
# in the next, and a checkout is an ordinary thing to hand an agent. A linked
# worktree already inherits that trust from the checkout it was made out of. A
# plain clone inherits nothing, so a human names its donor.
#
# What qualifies, once designated. The donor must declare OUR pins — a runtime
# is only valid for the lock file it was built from — and every payload it
# carries must be finished. Neither is a trust boundary any more; both are the
# difference between a copy that works and one that fails confusingly later.
payloads() {
  printf '%s\n' python-runtime camoufox-browser vault-server vault-cli
}

if [ "${1:-}" = "--payloads" ]; then
  payloads
  exit 0
fi

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
self=$(cd "$root" && pwd -P)

# A payload directory exists from the moment its fetch starts extracting into
# it; the build writes these markers last. So an absent payload is one this
# donor simply cannot give, while a present one without its marker is a fetch
# still in flight — and copying that hands over a payload missing most of
# itself, which the recipient's `already present` arm then keeps forever.
# What browserRuntime.ts will look for. Only this arch's trees matter: a donor
# holding the other one carries nothing this checkout can run.
arch=$(uname -m)

unfinished() {
  case $2 in
    python-runtime) [ ! -f "$1/vendor/python-runtime/.stamp" ] ;;
    # camoufoxIn() tries this arch first, then the fused universal tree, and
    # runs whichever it finds — so the gate needs one of the two present, and
    # which one only decides what the recipient ends up running. A donor
    # holding neither carries no browser this machine can start.
    camoufox-browser)
      [ ! -f "$1/vendor/camoufox-browser/$arch/.sha256" ] &&
        [ ! -f "$1/vendor/camoufox-browser/universal/.sha256" ] ;;
    # Two builds, and the cheap one finishes first: fetchVaultWebUi() runs
    # ahead of the vaultwarden compile, so .web-vault.sha256 alone would call a
    # donor ready while the Rust build it needs is still running.
    vault-server)
      [ ! -f "$1/vendor/vault-server/.web-vault.sha256" ] ||
        [ ! -f "$1/vendor/vault-server/$arch/.commit" ] ;;
    vault-cli) [ ! -f "$1/vendor/vault-cli/$arch/.sha256" ] ;;
    *) false ;;
  esac
}

qualifies() {
  # The Python runtime is the floor: the browser server runs on it, and it is
  # the slow half to rebuild. A donor without it has nothing worth copying.
  [ -d "$1/vendor/python-runtime" ] || return 1
  cmp -s "$1/vendor/browser-server/runtime.lock.json" \
    "$self/vendor/browser-server/runtime.lock.json" || return 1
  cmp -s "$1/vendor/browser-server/requirements.txt" \
    "$self/vendor/browser-server/requirements.txt" || return 1
  for payload in $(payloads); do
    [ -d "$1/vendor/$payload" ] || continue
    ! unfinished "$1" "$payload" || return 1
  done
  return 0
}

case "${1:-}" in
  --check)
    [ -n "${2:-}" ] || exit 1
    dir=$(cd "$2" 2>/dev/null && pwd -P) || exit 1
    [ "$dir" != "$self" ] || exit 1
    qualifies "$dir" || exit 1
    exit 0
    ;;
  --candidates)
    for candidate in "$(dirname "$self")"/*; do
      [ -d "$candidate" ] || continue
      candidate=$(cd "$candidate" 2>/dev/null && pwd -P) || continue
      [ "$candidate" != "$self" ] || continue
      qualifies "$candidate" && printf '%s\n' "$candidate"
    done
    exit 0
    ;;
esac

# Inheritance, and only inheritance. A linked worktree shares its git dir with
# the checkout it was made out of; a plain clone's common dir is its own, which
# is why the equality check leaves it with no donor rather than with itself.
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
parent=$(cd "$(dirname "$common")" 2>/dev/null && pwd -P) || exit 0
[ "$parent" != "$self" ] || exit 0
qualifies "$parent" && printf '%s\n' "$parent"
exit 0
