#!/bin/bash
# scripts/worktree-setup.sh [donor-checkout] — everything needed to make a
# second checkout buildable and runnable alongside the ones already here:
#
#   1. copies the gitignored browser runtime (Python + Camoufox + download
#      cache + vault server/CLI payloads, ~500 MB+) from a checkout that
#      already has one instead of re-downloading or recompiling it (APFS
#      clones, so it is instant and costs no disk on the same volume)
#   2. installs workspace dependencies and builds everything
#
# Works in any checkout — a linked worktree or a plain clone beside the others.
# Name a donor to copy a runtime from it; run it bare and there is none, and the
# browser stack is fetched later by whoever wants it. Nothing is inferred: the
# reasoning is beside the donor block below.
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

# --- browser runtime: copy it from the donor -------------------------------
#
# One way in: you name it, or there is none. A donor's payloads are executed
# here — the bundled Python runs the browser server, vaultwarden is spawned —
# outside the seatbelt and within reach of this checkout's vault and relay
# credential. Which checkout may hand this one a runtime is therefore a decision
# a human makes, and this script never infers it: inference would need a rule,
# the rule would need exceptions, and each exception would need a way past it.
#
# Whether what arrives is any GOOD is not decided here — see the build below.
donor=${1:-}
if [ -n "$donor" ]; then
  donor=$(cd "$donor" 2>/dev/null && pwd -P) || {
    echo "error: ${1} is not a directory." >&2
    exit 1
  }
  [ "$donor" != "$self" ] || {
    echo "error: a checkout cannot be its own donor." >&2
    exit 1
  }
  [ -f "$donor/vendor/browser-server/runtime.lock.json" ] || {
    echo "error: $donor is not a checkout of this repo." >&2
    exit 1
  }
fi

echo "checkout: $checkout"
echo "donor:    ${donor:-none — name one to copy a runtime instead of fetching it}"

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
  elif [ -n "$donor" ]; then
    # Only when there IS a donor, so this says what that donor could not give.
    # With no donor the banner has already said there is nothing to copy from,
    # and repeating it per payload is five lines carrying one fact.
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
# Only when `have_runtime` is set — see where it is set for what counts as
# present. A partial or stale runtime is exactly what wants completing, and the
# build knows which part.
#
# What that costs is not bounded by how much is already here. Whatever is
# missing or no longer matches its pins gets built, up to and including the
# cargo build of vaultwarden, which wants a Rust toolchain this machine may not
# have — so a checkout that received camoufox, the largest payload, can still
# owe that build, the most expensive one. The trade is deliberate: a checkout
# holding a runtime nothing has looked at is worse than one that took a while,
# and a checkout holding NO payload is the only case with nothing to complete,
# and so the only one worth skipping for.
#
# After install and build so a failure here costs only the validation — the
# checkout keeps its dependencies and its compiled output either way — and NOT
# suppressed: nothing else compares what is in vendor/ against what it should
# be, and
# browserRuntime.ts accepts payloads on path existence alone — camoufox on a
# config.json, the vault on its binary and web-vault dir, nothing on what is
# inside any of them. Swallowing this would sign the
# checkout off as ready over a runtime nothing has checked, which the app would
# then try to run. `--browser` builds the Python runtime too, so it is the only
# recipe needed.
if [[ -n "${have_runtime:-}" ]]; then
  just fetch-browser || {
    echo "" >&2
    echo "error: the runtime in vendor/ did not check out, so this checkout is" >&2
    echo "  NOT ready — its dependencies and build are in place, but the" >&2
    echo "  payloads have not been validated. That may be the payloads, or it" >&2
    echo "  may be this machine: building what is missing or out of date can" >&2
    echo "  want a Rust toolchain. The fetch above says which." >&2
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
