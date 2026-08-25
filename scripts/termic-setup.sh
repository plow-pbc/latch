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
[ -n "$donor" ] &&
  [ "$donor" != "$(pwd -P)" ] &&
  [ -f "$donor/vendor/browser-server/runtime.lock.json" ] ||
  donor=""

exec scripts/worktree-setup.sh ${donor:+"$donor"}
