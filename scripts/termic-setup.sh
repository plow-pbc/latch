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
# Anything that is not a usable donor becomes NO donor, which the script
# supports and which leaves the worktree exactly as a bare setup would. Passing
# a bad one instead would be REFUSED, and a refusal lands before the install and
# build, so the worktree would come out with no dependencies and nothing built —
# worse off than the missing runtime this hook exists to fix.
set -euo pipefail
cd "$(dirname "$0")/.."

donor=$(cd "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")" 2>/dev/null && pwd -P) ||
  donor=""
# The root of a working tree, and not this one. A bare clone with worktrees
# beside it leaves the common dir with no checkout around it; run from the main
# checkout, what it names is that checkout itself. `.git` is a file rather than
# a directory under --separate-git-dir, and that is still a checkout.
[ -n "$donor" ] && [ -e "$donor/.git" ] && [ "$donor" != "$(pwd -P)" ] || donor=""

exec scripts/worktree-setup.sh ${donor:+"$donor"}
