#!/bin/bash
# scripts/termic-setup.sh — .termic.yaml's setup hook: worktree-setup.sh with a
# donor named for it.
#
# worktree-setup.sh never infers a donor; the caller that knows one says it.
# Termic runs this inside a worktree it has just created, and what git can name
# from in here is the repository's MAIN checkout — NOT "the checkout this was
# made from": a worktree created from another worktree still resolves to main.
# For the layout this repo is developed in they are the same directory.
#
# A script rather than the expression inline in .termic.yaml because nothing
# establishes that Termic evaluates that value through a shell — the other hooks
# are all plain argv — and a shebang needs no such assumption.
#
# Anything this cannot vouch for becomes NO donor, which the script supports and
# which leaves the worktree exactly as a bare setup would. Passing a bad one
# instead would be REFUSED, and a refusal lands before the install and build, so
# the worktree would come out with no dependencies and nothing built — worse off
# than the missing runtime this hook exists to fix.
set -euo pipefail
cd "$(dirname "$0")/.."

# On the lookup itself, not on the `cd`: expansions run before redirections, so
# a `cd` cannot silence the substitution feeding it. Outside a repo this is the
# stderr there is, and it would land in Termic's setup log.
donor=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) &&
  donor=$(cd "$(dirname "$donor")" 2>/dev/null && pwd -P) || donor=""

# worktree-setup.sh's own refusal, asked here. A guard that asks a DIFFERENT
# question than the refusal it exists to avoid is not a guard: this used to ask
# whether the donor was a git checkout, which a main checkout parked on an older
# commit answers yes to and setup still refuses. The layouts that resolve to no
# checkout at all — a bare clone hosting worktrees, --separate-git-dir — fail
# this too, which is why there is one predicate here and not two.
if [ -z "$donor" ] || [ "$donor" = "$(pwd -P)" ]; then
  # Run from the main checkout, or from a layout with nothing beside the common
  # dir. Silent: there is no other checkout to point anyone at.
  donor=""
elif [ ! -f "$donor/vendor/browser-server/runtime.lock.json" ]; then
  # Said here because setup cannot say it: it will report no donor and offer
  # "name one", which is advice this caller structurally cannot take — the hook
  # exists because Termic's setup hook passes no argument. Without this the log
  # reads as though no runtime was ever there to copy.
  #
  # The tested fact, not setup's wording for it. "Not a checkout of this repo"
  # is plausible for a donor a human typed and wrong for one git resolved: the
  # case this predicate was chosen for — a main checkout parked on a commit
  # before the lockfile — IS a checkout of this repo, and the layouts that land
  # on a parent directory are not anywhere a runtime would come from. Naming
  # the file is also the only form of this that says what to go and fix.
  echo "note: $donor holds no vendor/browser-server/runtime.lock.json, so there" >&2
  echo "  is no runtime to copy from it. Starting without a browser or a vault." >&2
  donor=""
fi

exec scripts/worktree-setup.sh ${donor:+"$donor"}
