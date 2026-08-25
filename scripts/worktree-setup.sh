#!/bin/bash
# scripts/worktree-setup.sh [donor-checkout | --no-donor] — everything needed to
# make a second checkout buildable and runnable alongside the ones already here:
#
#   1. copies the gitignored browser runtime (Python + Camoufox + download
#      cache + vault server/CLI payloads, ~500 MB+) from a checkout that
#      already has one instead of re-downloading or recompiling it (APFS
#      clones, so it is instant and costs no disk on the same volume)
#   2. installs workspace dependencies and builds everything
#
# Works in any checkout — a linked worktree or a plain clone beside the others.
# A worktree inherits its donor from the checkout it was made out of; a plain
# clone inherits nothing and is given one, because a donor's payloads get
# executed here (the reasoning is beside the donor block below). Run it with no
# argument and it will list the candidates it can see.
#
# State is keyed on the normalized BRANCH name (scripts/worktree-name.sh) — for
# EVERY checkout, the main one included; only the packaged install uses the
# unsuffixed defaults. Two plain clones on one branch therefore share all of it
# (see CLAUDE.md); only a linked worktree is guaranteed a branch to itself:
#
#   app home          ~/Library/Application Support/Plow-Latch-<branch>
#   local-relay home  ~/Library/Application Support/Plow-Latch-<branch>-local
#   Electron userData inside the home (<home>/electron) — one folder per instance
#   screenshots       /tmp/plow-latch-<branch>                    (main: /tmp)
#
# What is deliberately NOT copied: settings.json and the relay credential in
# it. A checkout whose branch is its own gets its own credential on first
# `just app`; one sharing a branch inherits the home above, credential and all,
# which is why that case wants its own DOMO_HOME.
# `just package` stays main-only (shared electron-builder caches + keychain).
set -euo pipefail
cd "$(dirname "$0")/.."

checkout=$(sh scripts/worktree-name.sh --branch)
self=$(pwd -P)

# The vendor dirs a runtime is made of. The download cache is not one of them:
# it is what a fetch downloads FROM, so it is copied but never counted.
payloads="python-runtime camoufox-browser vault-server vault-cli"

# A checkout of this repo, and not this one. Nothing about its payloads — a
# directory with none copies nothing, and the build below fills it in.
usable() {
  [ "$1" != "$self" ] || return 1
  [ -f "$1/vendor/browser-server/runtime.lock.json" ] || return 1
}

# --- browser runtime: copy it from the donor -------------------------------
#
# Who may hand this checkout a runtime, which is the one part of this that
# cannot be delegated. A donor's payloads are executed here — the bundled
# Python runs the browser server, vaultwarden is spawned — outside the seatbelt
# and within reach of this checkout's vault and relay credential. So a plain
# clone is TOLD its donor rather than finding one: scanning whatever sits
# nearby would let anything able to write ONE checkout put code in the next,
# and a checkout is an ordinary thing to hand an agent. A linked worktree
# inherits that trust from the checkout it was made out of; everything else a
# human names.
#
# Whether what arrives is any GOOD is not decided here — see the build below.
donor=${1:-}
# An explicit "set up without one" — for a checkout that will fetch its own, or
# whose neighbours you would rather not copy. Without it a refusal has no way
# past, and the refusal happens before install and build.
if [ "$donor" = "--no-donor" ]; then
  donor=""
  refused=1
elif [ -n "$donor" ]; then
  donor=$(cd "$donor" 2>/dev/null && pwd -P) || {
    echo "error: ${1} is not a directory." >&2
    exit 1
  }
  if [ "$donor" = "$self" ]; then
    echo "error: a checkout cannot be its own donor." >&2
    exit 1
  fi
  usable "$donor" || {
    echo "error: $donor is not a checkout of this repo." >&2
    exit 1
  }
else
  # Inheritance, and only inheritance. A linked worktree shares its git dir
  # with the checkout it was made out of; a plain clone's common dir is its
  # own, which is why `usable` leaves it with no donor rather than with itself.
  donor=""
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  if [ -n "$common" ]; then
    parent=$(cd "$(dirname "$common")" 2>/dev/null && pwd -P || true)
    [ -n "$parent" ] && usable "$parent" && donor=$parent
  fi
  # Nothing inherited. If something nearby WOULD serve, that is the human's
  # call to make and not this script's. With nothing nearby either there is
  # nothing to choose between, so carry on and let the per-payload notes below
  # say what did not come across.
  if [ -z "$donor" ]; then
    # Advice, never a choice: the neighbours a human could name. Listing is
    # not choosing, which is the whole point of the paragraph above.
    candidates=$(
      for candidate in "$(dirname "$self")"/*; do
        [ -d "$candidate" ] || continue
        candidate=$(cd "$candidate" 2>/dev/null && pwd -P) || continue
        usable "$candidate" || continue
        # Worth naming only if it has something to give — python-runtime, the
        # payload every runtime has and the slow half to rebuild, taken from the
        # list rather than spelled again.
        #
        # `-d`, matching the arm that COPIES rather than the arm that skips. The
        # two ask different questions: skipping asks "would a copy clobber
        # something", where anything present counts, and this asks "is there
        # something to copy", where a regular file at that path is not. Getting
        # it wrong advertises a neighbour that then clones nothing.
        #
        # An `if` rather than a `&&`: this is the loop's last command, so under
        # `set -e` a final candidate that does not qualify aborts the setup.
        if [ -d "$candidate/vendor/${payloads%% *}" ]; then
          printf '%s\n' "$candidate"
        fi
      done
    )
    if [ -n "$candidates" ]; then
      # Two ways to get here — not a linked worktree, or one whose parent
      # checkout has no usable runtime either — and the answer is the same, so
      # say what is true of both rather than guessing which.
      echo "error: this checkout has no donor to inherit, and will not adopt a" >&2
      echo "  neighbour on its own. Name one, or pass --no-donor to set up" >&2
      echo "  without a runtime. Nearby checkouts with one to copy:" >&2
      # One path per line, unsplit: a checkout directory may contain spaces.
      printf '%s\n' "$candidates" | while IFS= read -r candidate; do
        echo "    $candidate" >&2
      done
      exit 1
    fi
  fi
fi

echo "checkout: $checkout"
if [ -n "$donor" ]; then
  echo "donor:    $donor"
elif [ -n "${refused:-}" ]; then
  echo "donor:    none — --no-donor was passed, so nothing is being copied"
else
  echo "donor:    none — nothing nearby to copy from"
fi

for payload in $payloads downloads; do
  dir="vendor/$payload"
  if [[ -e "$dir" ]]; then
    echo "$dir already present — leaving it alone"
  elif [[ -n "$donor" && -d "$donor/$dir" ]]; then
    echo "cloning $dir from the donor…"
    # Into a sibling, then renamed into place: a copy interrupted half-way
    # (^C, a full disk) would otherwise leave a partial payload that the
    # `already present` arm above preserves forever — setup would report the
    # checkout ready over a runtime that is missing most of itself. rename(2)
    # is atomic, so the destination either does not exist or is complete.
    # -c uses APFS clonefile; fall back to a plain copy on other filesystems.
    # Cleared before EACH attempt: on a non-APFS volume the clone copy fails
    # part-written, and a fallback into what it left behind nests the payload a
    # directory deeper instead of replacing it.
    rm -rf "$dir.partial"
    cp -Rpc "$donor/$dir" "$dir.partial" 2>/dev/null || {
      rm -rf "$dir.partial"
      cp -Rp "$donor/$dir" "$dir.partial"
    }
    mv "$dir.partial" "$dir"
  else
    echo "note: no $dir to clone — run \`just fetch-browser\` if you need the browser stack"
  fi
  # Present, however it got here — copied just now or already in place, and
  # `-e` so this agrees with the skip arm above on what present means. The
  # download cache does not count: it is what a fetch downloads FROM, so on its
  # own it leaves nothing to validate. Keyed on presence rather than on having
  # copied this run, because otherwise a second run of this script finds every
  # payload already there, skips the check, and signs the checkout off over
  # exactly the copy that failed it the first time.
  [[ "$payload" = downloads || ! -e "$dir" ]] || have_runtime=1
done

# --- deps + build ----------------------------------------------------------
just install
just build

# The donor was a cache seed, not an authority, so what came across is checked
# by the build that owns it — stamps that compare content and repair exactly
# what does not match. A good copy makes this a no-op; a stale or half-built one
# costs the rebuild it should have.
#
# Only when there is a runtime here to check. A checkout with none is not a
# reason to start a cold build: that is ~200 MB of Python, a 320 MB browser and
# a cargo build of vaultwarden, needing a Rust toolchain that setting a checkout
# up has never needed.
#
# After install and build so a failure here costs only the validation — the
# checkout is left with its dependencies and its compiled output either way —
# but not suppressed: this is the ONLY content-aware look at what was copied,
# and browserRuntime.ts accepts payloads on path existence alone, so swallowing
# it would sign the checkout off as ready over a runtime nothing has checked.
# `--browser` runs the Python build too, so it is the only recipe needed here.
if [[ -n "${have_runtime:-}" ]]; then
  just fetch-browser || {
    echo "" >&2
    echo "error: the runtime in vendor/ did not check out, so this checkout is" >&2
    echo "  NOT ready — its dependencies and build are in place, but the" >&2
    echo "  payloads have not been validated." >&2
    echo "" >&2
    echo "  Fix whatever the fetch reported and run \`just fetch-browser\` here," >&2
    echo "  or remove the payloads from vendor/ to start over. Re-running this" >&2
    echo "  script will check them again either way." >&2
    exit 1
  }
fi

echo ""
echo "Checkout '$checkout' is ready."
echo "  run the suite:   just test"
echo "  launch the app:  just app     (state in \"~/Library/Application Support/Plow-Latch-$checkout\")"
echo ""
# The home is keyed on the branch, and only a linked worktree is guaranteed to
# have that to itself. Say so here rather than promising a per-checkout
# credential the key cannot deliver — see CLAUDE.md.
echo "That home is keyed on the BRANCH, not this directory. Another checkout on"
echo "'$checkout' shares it — same relay credential, identity and audit log."
echo "Set DOMO_HOME, or use another branch, before running both."
