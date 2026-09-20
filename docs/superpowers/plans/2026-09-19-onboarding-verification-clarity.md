# Onboarding Verification Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace explanatory onboarding copy with a self-explanatory Messages preview, a countdown that becomes retry, and a more compact Gatekeeper prompt/default layout.

**Architecture:** Keep the existing onboarding state machine and IPC actions unchanged. Reshape only the renderer DOM/CSS, extend the real Electron screenshot harness to assert accessibility and visual order, and use an expired activation fixture to prove the timer changes into a retry action without backend help.

**Tech Stack:** Electron 33, browser-native JavaScript and CSS, Vitest, the repository's real-window screenshot harness.

**Spec:** User-approved bounded design captured verbatim in Global Constraints below; no separate architectural spec is required.

## Global Constraints

- Phone verification uses direction C: a familiar Messages conversation preview instead of explanatory instructions.
- The destination phone number and activation message each have an icon-only copy control with an accessible label.
- A compact warning says the activation code is private and that sending it links the account.
- The live countdown remains visible and becomes a single `Try again` action when it reaches zero.
- The primary action reads `Send in Messages` and continues to call the existing `onboardingOpenMessages` IPC action.
- Gatekeeper supporting copy is exactly `Protect your data from malicious queries, while allowing your agents to get useful work done.`
- `What access should Plow Latch allow to your Mac?` appears immediately above the text box.
- `Use a default:` and the `Personal assistant` / `Executive assistant` text links appear immediately below the text box.
- The built-in Obsidian-style wiki remains enabled/ready in plugin state but is omitted from onboarding because it requires no permission or setup decision.
- Do not change onboarding state transitions, activation protocol, Gatekeeper preview semantics, or footer navigation.
- Do not merge or deploy; leave the exact reviewed head for the operator.

---

### Task 1: Messages-style phone verification

**Files:**
- Modify: `apps/desktop/src/renderer/onboarding-fixtures.js`
- Modify: `apps/desktop/src/renderer/onboarding.js`
- Modify: `apps/desktop/src/renderer/onboarding.css`
- Modify: `apps/desktop/scripts/screenshot-harness.mjs`

**Interfaces:**
- Consumes: existing activation fields `sendTo`, `smsBody`, `pollUntil`, and existing `window.domo.onboardingOpenMessages()` / `window.domo.onboardingNewCode()` actions.
- Produces: `copyButton(value, ariaLabel)`, a Messages-style `.message-preview`, and a `.waiting-status` whose expired state contains `Try again`.

- [ ] **Step 1: Write failing real-window expectations**

Add fixture assertions for `Connect with a text`, `Send in Messages`, both copy-control labels, absence of old explanatory copy, and an activation whose `pollUntil` is already past and must render `Try again` rather than `Waiting for your text`.

- [ ] **Step 2: Run the real Electron screenshots and verify RED**

Run: `just onboarding-screenshots`

Expected: FAIL on the verification fixtures because the old renderer lacks the new title, copy labels, Messages preview wording, and local expired retry state.

- [ ] **Step 3: Implement the minimal renderer behavior**

Change `copyButton` to accept an accessible label and compact icon-only presentation. Build one Messages preview containing the phone number and activation body, each with its own copy control. Change the primary label to `Send in Messages`. Have `startActivationCountdown` update the compact waiting row and replace it with a `Try again` button calling `window.domo.onboardingNewCode()` when time reaches zero; do not retain the always-visible resend link.

- [ ] **Step 4: Style the approved direction**

Replace the send block, caution paragraph, and separate countdown/action spacing with a centered Messages card, contact circle, blue outgoing bubble, compact copy buttons, and one status row. Preserve keyboard focus, contrast, reduced-motion behavior, and the existing wizard/footer geometry.

- [ ] **Step 5: Verify GREEN**

Run: `just onboarding-screenshots`

Expected: PASS for `verify`, `verify-rearm`, `waiting`, `verify-expired`, and `waiting-gave-up`, with PNGs written for manual inspection.

### Task 2: Compact Gatekeeper copy and control order

**Files:**
- Modify: `apps/desktop/src/renderer/onboarding-fixtures.js`
- Modify: `apps/desktop/src/renderer/onboarding.js`
- Modify: `apps/desktop/src/renderer/onboarding.css`
- Modify: `apps/desktop/scripts/screenshot-harness.mjs`

**Interfaces:**
- Consumes: existing `choosePreset("home" | "work")` actions and `gatekeeper.text` textarea binding.
- Produces: `.gk-prompt` and a top-to-bottom DOM/visual order of subhead, prompt, textarea, defaults, and preview field.

- [ ] **Step 1: Write failing copy and order expectations**

Add the exact approved Gatekeeper sentences to `gatekeeper-home`, reject the old adversarial-reviewer sentence, and assert selector order `subhead → .gk-prompt → .gk-text → .gk-defaults → .gk-field` in the screenshot harness.

- [ ] **Step 2: Run the real Electron screenshots and verify RED**

Run: `just onboarding-screenshots`

Expected: FAIL because `.gk-prompt` is absent, the defaults precede the textarea, and the old sentence still renders.

- [ ] **Step 3: Implement exact copy and ordering**

Render the approved supporting sentence as the header subhead. Render `What access should Plow Latch allow to your Mac?` as `.gk-prompt` immediately before the textarea. Render defaults immediately after the textarea, using underlined text-link styling while retaining button semantics and the existing preset actions. Update the textarea aria-label to the approved question.

- [ ] **Step 4: Verify GREEN and inspect both screenshots**

Run: `just onboarding-screenshots`

Expected: PASS, including selector order and existing Gatekeeper result rows. Inspect the generated phone verification and Gatekeeper PNGs at native size for clipping, overlap, hierarchy, and footer clearance.

### Task 3: Hide the permission-free wiki choice

**Files:**
- Modify: `apps/desktop/src/renderer/onboarding-fixtures.js`
- Modify: `apps/desktop/src/renderer/onboarding.js`
- Test: `apps/desktop/test/onboardingFixtures.test.ts`

**Interfaces:**
- Consumes: the complete `pluginsState.rows` collection used for examples, persistence, and grant calculation.
- Produces: onboarding choice rows that omit default-on, permission-free plugins without mutating plugin state.

- [ ] **Step 1: Write the failing visibility/state test**

Require `plugins-fresh` to reject visible `Obsidian-style wiki`, while the fixture test still asserts that its underlying wiki row exists with status `ready` and an empty requirements list.

- [ ] **Step 2: Run focused tests and screenshots to verify RED**

Run `npm test -- apps/desktop/test/onboardingFixtures.test.ts` and `just onboarding-screenshots`.

Expected: the model-state assertion passes and the real-window screenshot fails because the renderer still exposes the wiki toggle.

- [ ] **Step 3: Filter only the onboarding choice rows**

Render only rows that are off or have requirements: `pluginsState.rows.filter((row) => row.status === "off" || row.requirements.length > 0)`. Do not filter the source state, examples, grant calculation, settings, or persisted plugin enablement.

- [ ] **Step 4: Verify GREEN**

Run `npm test -- apps/desktop/test/onboardingFixtures.test.ts` and `just onboarding-screenshots`.

Expected: PASS; the wiki stays ready in fixture/model state and does not appear in the onboarding screenshot.

### Task 4: Repository gate and pull-request convergence

**Files:**
- Verify: all modified files above
- Verify: `docs/superpowers/plans/2026-09-19-onboarding-verification-clarity.md`

**Interfaces:**
- Consumes: repository build/test commands and the committed feature branch.
- Produces: a pushed pull request whose exact head has green required checks and a clean KWR review.

- [ ] **Step 1: Run focused and canonical verification**

Run `npm test -- apps/desktop/test/onboardingFixtures.test.ts`, `just onboarding-screenshots`, and the repository's canonical gate discovered from `AGENTS.md`, `README-ts.md`, or `justfile`. Confirm command exit codes and inspect the generated PNGs.

- [ ] **Step 2: Commit explicit paths and push**

Stage only the plan, renderer, CSS, fixtures, and screenshot harness. Confirm `.superpowers/` remains untracked. Commit with a concise message and push `feat/onboarding-verification-clarity` without force.

- [ ] **Step 3: Open and bind the pull request**

Open an operator-controlled `plow-pbc/latch` pull request whose body leads with the user-visible behavior changes, includes verification evidence, and states that merge/deploy remain with the operator.

- [ ] **Step 4: Run babysit-pr through exact-head convergence**

Read every review surface, independently verify findings, batch valid fixes, rerun the canonical gate, push, and request exactly one `/srosro-update-review` after each changed head. Continue until the latest KWR review names the current head, contains no unresolved in-scope finding, and required checks are green.

- [ ] **Step 5: Stop before merge or deployment**

Freshly fetch the pull request state, report the converged head and verification evidence, and leave the pull request open for the operator.
