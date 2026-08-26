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
# Only ever run in a worktree Termic just made, so there is always a repository
# to ask and the answer is never this checkout. The one thing that IS reachable
# is a main checkout without the runtime — parked on a commit from before it —
# and that becomes NO donor rather than one setup will refuse: a refusal lands
# before the install and the build, so the worktree would come out with no
# dependencies and nothing compiled, worse off than the missing runtime this
# hook exists to fix.
set -euo pipefail
cd "$(dirname "$0")/.."

donor=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
if [ -f "$donor/vendor/browser-server/runtime.lock.json" ]; then
  exec scripts/worktree-setup.sh "$donor"
fi

# The tested fact, not setup's wording for it: setup will report no donor and
# offer "name one", which this caller structurally cannot do. Naming the file is
# also the only form of this that says what to go and restore.
echo "note: $donor holds no vendor/browser-server/runtime.lock.json, so there" >&2
echo "  is no runtime to copy from it. Starting without a browser or a vault." >&2
exec scripts/worktree-setup.sh
