#!/bin/sh
# Which checkout this one may copy its browser runtime from.
#
#   (no args)      the donor this checkout INHERITS — the one a linked worktree
#                  was created out of — or nothing. A plain clone inherits none.
#   --check DIR    exit 0 if DIR is a checkout this one may copy from
#   --candidates   nearby checkouts worth naming, one per line. Advice for the
#                  human choosing one; never a choice this script makes.
#   --payloads     the vendor dirs a runtime is made of, one per line. One owner
#                  for the list: worktree-setup.sh copies these (plus the
#                  download cache) and the suite reads them.
#
# What this decides, and what it does not.
#
# It decides WHO. A donor's payloads are executed here — the bundled Python runs
# the browser server and vaultwarden is spawned, both outside the seatbelt and
# both within reach of this checkout's vault and relay credential — so a plain
# clone is told its donor rather than finding one. Scanning whatever sits nearby
# would let anything able to write ONE checkout put code in the next, and a
# checkout is an ordinary thing to hand an agent. A linked worktree inherits
# that trust from the checkout it was made out of; everything else a human names.
#
# It does not decide WHETHER what was copied is any good. That is
# build-browser-runtime.mjs's job and it is better at it: its stamps compare
# content, not existence, and it repairs exactly what does not match. So
# worktree-setup.sh runs it after the copy and treats the donor as a cache seed
# — a stale or half-built payload costs the rebuild it should have cost, rather
# than being refused up front by a second, weaker notion of "ready" that has to
# be kept in step with five producers.
payloads() {
  printf '%s\n' python-runtime camoufox-browser vault-server vault-cli
}

if [ "${1:-}" = "--payloads" ]; then
  payloads
  exit 0
fi

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
self=$(cd "$root" && pwd -P)

# A checkout of this repo, and not this one. Nothing about its payloads: a
# directory with none copies nothing, and the build that follows fills it in.
usable() {
  [ "$1" != "$self" ] || return 1
  [ -f "$1/vendor/browser-server/runtime.lock.json" ] || return 1
}

case "${1:-}" in
  --check)
    [ -n "${2:-}" ] || exit 1
    dir=$(cd "$2" 2>/dev/null && pwd -P) || exit 1
    usable "$dir" || exit 1
    exit 0
    ;;
  --candidates)
    for candidate in "$(dirname "$self")"/*; do
      [ -d "$candidate" ] || continue
      candidate=$(cd "$candidate" 2>/dev/null && pwd -P) || continue
      usable "$candidate" || continue
      # Worth naming, not vouched for: something to copy beats nothing, and
      # whether it is current is settled by the build afterwards.
      [ -d "$candidate/vendor/python-runtime" ] && printf '%s\n' "$candidate"
    done
    exit 0
    ;;
esac

# Inheritance, and only inheritance. A linked worktree shares its git dir with
# the checkout it was made out of; a plain clone's common dir is its own, which
# is why `usable` leaves it with no donor rather than with itself.
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
parent=$(cd "$(dirname "$common")" 2>/dev/null && pwd -P) || exit 0
usable "$parent" && printf '%s\n' "$parent"
exit 0
