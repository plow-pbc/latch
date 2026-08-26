#!/bin/bash
# scripts/termic-setup.sh — .termic.yaml's setup hook: worktree-setup.sh with a
# donor named for it. See CLAUDE.md, which names this as the one caller that
# chooses a donor for you.
#
# worktree-setup.sh never infers one; the caller that knows says it. Termic runs
# this inside a worktree it has just created, and what git names from in here is
# the repository's MAIN checkout — NOT "the checkout this was made from": a
# worktree created from another worktree still resolves to main.
#
# A script rather than the expression inline in .termic.yaml because nothing
# establishes that Termic evaluates that value through a shell — the other hooks
# are all plain argv — and a shebang needs no such assumption.
#
# Anything this cannot vouch for becomes NO donor, which setup supports and
# which leaves the worktree exactly as a bare setup would. Handing over one it
# will REFUSE is the outcome worth spending lines on: a refusal lands before the
# install and the build, so the worktree comes out with no dependencies and
# nothing compiled — worse off than the missing runtime this hook exists to fix.
set -euo pipefail
cd "$(dirname "$0")/.."

# Two statements, so `set -e` sees git's status: in one, the assignment takes
# `dirname`'s status instead, git's failure is swallowed, and `dirname ""` hands
# back "." — a donor that is this checkout, wearing another name.
common=$(git rev-parse --path-format=absolute --git-common-dir)
donor=$(cd "$(dirname "$common")" && pwd -P)

if [ "$donor" = "$(pwd -P)" ]; then
  # Run somewhere that is its own main checkout rather than a worktree of one.
  # Silent: there is no other checkout to point anyone at, and setup would
  # refuse this one as its own donor.
  donor=""
elif [ ! -f "$donor/vendor/browser-server/runtime.lock.json" ]; then
  # A main checkout parked on a commit from before the runtime. The tested
  # fact, not setup's wording for it — setup will report no donor and offer
  # "name one", which this caller structurally cannot do, and naming the file
  # is the only form of this that says what to go and restore.
  echo "note: $donor holds no vendor/browser-server/runtime.lock.json, so there" >&2
  echo "  is no runtime to copy from it. Starting without a browser or a vault." >&2
  donor=""
fi

exec scripts/worktree-setup.sh ${donor:+"$donor"}
