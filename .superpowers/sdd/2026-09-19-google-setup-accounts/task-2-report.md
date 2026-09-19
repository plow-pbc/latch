# Task 2 report — setup can add Google accounts

Commit: `25c38aeaa81cb920f887e07e05200413a0bc66d8` (`Let setup connect another Google account`)

## Changed files

- `apps/desktop/src/pluginsModel.ts`
- `apps/desktop/src/renderer/onboardingGrants.js`
- `apps/desktop/src/renderer/onboarding.js`
- `apps/desktop/test/pluginsModel.test.ts`
- `apps/desktop/test/onboardingGrants.test.ts`
- `apps/desktop/test/connectors.test.ts`

## Behavior delivered

- A met account requirement exposes the model-owned `Add another` repeat label;
  permission requirements expose none.
- Setup renders that generic repeat action beside the met status and invokes the
  existing `requirements:act` bridge exactly once, without restarting the
  primary open-grant runner.
- Fresh plugin state clears a transient row miss once that row is no longer
  open.
- Successive connection snapshots retain account one while actions add account
  two and then account three.

## Red/green evidence

- Red: `npx vitest run apps/desktop/test/pluginsModel.test.ts apps/desktop/test/onboardingGrants.test.ts` — 3 expected failures before implementation: missing `repeatAction`, missing `actGrant`, and missing `clearMissed`.
- Green: `npx vitest run apps/desktop/test/connectors.test.ts apps/desktop/test/pluginsModel.test.ts apps/desktop/test/onboardingGrants.test.ts` — 3 files, 69 tests passed.
- `npx tsc -b` — passed.
- `just test` — 131 files passed, 1 skipped; 2,524 tests passed, 4 skipped.
- `git diff --check` — passed.

## Self-review

The renderer reads both the repeated-action label and requirement id from the
model; it contains no account-specific identifier. `actGrant` is the common
single-action seam used by the open-grant runner and repeat control, so the
repeat control cannot traverse the remaining open grants. `clearMissed` only
removes the transient error after fresh state reports the same row no longer
open.

## Concerns

None.
