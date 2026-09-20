# Audit Gatekeeper Denial UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Rules tab and one-time retry override, then make Audit the home for Gatekeeper policy, rule management, and denial recovery.

**Architecture:** Keep the existing main-process ownership of settings, rules, denial state, and revision coaching. Move their renderer composition into the existing Audit master-detail view: a Gatekeeper policy card above Audit, a rule-management modal, recovery inside the selected row's detail pane, and one renderer-level notice on non-Audit tabs. Delete the override authorization path in device-core instead of leaving hidden behavior.

**Tech Stack:** TypeScript, Electron IPC/contextBridge, vanilla renderer JavaScript/CSS, Vitest, Electron preload UI probe, screenshot harness.

**Spec:** `docs/superpowers/specs/2026-09-20-audit-gatekeeper-denial-ux-design.md`

## Global Constraints

- Work only in `/Users/so/Hacking/latch4`; do not create a worktree.
- Remove **Allow one retry** from policy, IPC, UI, copy, tests, and documentation.
- Keep **Suggest revised instructions** in the selected denied activity's right-side detail pane.
- Remove **Keep as-is**; dismissal is the recovery card's `×` and changes neither policy nor audit history.
- Remove the Rules tab; a persisted `rules` tab selection opens Audit.
- Gatekeeper uses a `Gatekeeper` title plus clickable `Enabled` status pill/dropdown and `View N rules` action.
- The prompt is always visible and serially autosaves after typing pauses with Saving, Saved, and failure states.
- Amber is reserved for the denied row/recovery action; the cross-tab attention notice is neutral blue-gray.
- Insert all operation-derived strings with `textContent`, never HTML.
- Preserve historical display support for already-recorded `owner_override` audit sources, but create no new ones.
- Canonical gate is `just test`; UI verification also runs the preload probe and screenshot harness.

---

### Task 1: Delete the one-time override authorization path

**Files:**
- Modify: `packages/device-core/src/policyEngine.ts`
- Modify: `packages/device-core/src/deviceAgent.ts`
- Modify: `apps/desktop/src/reviewPolicy.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/preload.cts`
- Modify: `packages/mcp-server/src/handler.ts`
- Modify: `packages/device-core/test/deviceCore.test.ts`
- Modify: `apps/desktop/test/reviewPolicy.test.ts`
- Modify: `packages/mcp-server/test/toolCopy.test.ts`
- Modify: `DESIGN.md`

**Interfaces:**
- Consumes: existing `PolicyEngine.deniedIntent(intentId)` and `reviewer_denied` event.
- Produces: `DeniedIntent { intent: Intent; reason: string | null }` with no state, no `armDeniedIntentOnce`, no `gatekeeperRecovery:allowOnce`, and no `owner_override` grant creation.

- [ ] **Step 1: Replace override-positive tests with denial-again tests**

In `packages/device-core/test/deviceCore.test.ts`, delete tests whose contract is arming or consuming an override and add a test that decides the same request twice through an adversarial-denying delegate:

```ts
it("does not authorize a retry after a reviewer denial", async () => {
  const engine = new PolicyEngine(rulesFile());
  const intent = makeIntent({ request: "run: say Hello World" });
  const reviewerDenies = { decideIntent: async () => ({ decision: "deny" as const, source: "adversarial", reason: "not allowed" }) };

  expect((await engine.decide(intent, reviewerDenies)).decision).toBe("deny");
  expect((await engine.decide({ ...intent, intentId: randomUUID() }, reviewerDenies)).decision).toBe("deny");
});
```

Update review-policy tests so they no longer import or assert `ownerOverrideMayGrant`.

- [ ] **Step 2: Verify the new contract fails against current production code**

Run:

```bash
npx vitest run packages/device-core/test/deviceCore.test.ts apps/desktop/test/reviewPolicy.test.ts packages/mcp-server/test/toolCopy.test.ts
```

Expected: failure from remaining override APIs/copy or retry behavior.

- [ ] **Step 3: Remove override code and update denial copy**

In `policyEngine.ts`:

- replace `DeniedIntentState`/stateful `DeniedIntent` with `{ intent, reason }`;
- remove `oneTimeOverrides`, `armDeniedIntentOnce`, `oneTimeFingerprint`, override events, and the override-first branch in `decide`;
- remove `mayGrantFromOwnerOverride` from `PolicyDelegate` and its helper/implementations.

In desktop main/preload remove `gatekeeperRecovery:allowOnce` and its bridge. Remove listeners for `override_armed` and `override_consumed`. Update fixed copy to:

```text
Gatekeeper's AI Reviewer denied this request. Ask the user to open Plow Latch on their Mac, where they can review the denial or improve their Gatekeeper instructions. Do not retry unchanged until the owner updates those instructions
```

Apply the equivalent sentence to MCP `SERVER_INSTRUCTIONS`, notifications, and DESIGN.md. Leave `auditView.ts` historical `owner_override` rendering intact.

- [ ] **Step 4: Run focused tests green**

Run the command from Step 2. Expected: all selected files pass and searches find no live override API:

```bash
rg -n "armDeniedIntentOnce|oneTimeOverrides|override_armed|override_consumed|gatekeeperRecoveryAllowOnce|allow one matching retry|Allow one retry" packages apps DESIGN.md
```

Expected: no matches except frozen migration/history fixtures explicitly retained.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/device-core/src/policyEngine.ts packages/device-core/src/deviceAgent.ts apps/desktop/src/reviewPolicy.ts apps/desktop/src/main.ts apps/desktop/src/preload.cts packages/mcp-server/src/handler.ts packages/device-core/test/deviceCore.test.ts apps/desktop/test/reviewPolicy.test.ts packages/mcp-server/test/toolCopy.test.ts DESIGN.md
git commit -m "Remove Gatekeeper retry overrides"
```

### Task 2: Add focused renderer state helpers for autosave and denial attention

**Files:**
- Create: `apps/desktop/src/renderer/gatekeeperState.js`
- Create: `apps/desktop/test/gatekeeperState.test.ts`

**Interfaces:**
- Produces: `modeView(mode, available)`, `createSerialAutosave(save, delayMs)`, and `attentionMatches(attention, activity)`.
- `createSerialAutosave` returns `{ edit(value), flush(), state(), subscribe(cb), dispose() }`; state is `{ phase: "idle" | "saving" | "saved" | "error"; draft: string; stored: string }`.

- [ ] **Step 1: Write failing pure-helper tests**

Cover:

```ts
expect(modeView("adversarial", true).label).toBe("Enabled");
expect(modeView("approve", true).description).toContain("without review");
expect(attentionMatches({ intentId: "i1" }, { intentId: "i1", decisionKind: "denied" })).toBe(true);
```

Use fake timers to prove two edits during an in-flight save persist in order and never report Saved for the old draft:

```ts
const writes: string[] = [];
let release!: () => void;
const first = new Promise<void>((resolve) => { release = resolve; });
const autosave = createSerialAutosave(async (value) => { writes.push(value); if (writes.length === 1) await first; return value; }, 50);
autosave.edit("first");
await vi.advanceTimersByTimeAsync(50);
autosave.edit("second");
release();
await autosave.flush();
expect(writes).toEqual(["first", "second"]);
expect(autosave.state()).toMatchObject({ phase: "saved", stored: "second" });
```

Also prove rejection keeps the draft and enters error.

- [ ] **Step 2: Run the helper test red**

```bash
npx vitest run apps/desktop/test/gatekeeperState.test.ts
```

Expected: module/functions do not exist.

- [ ] **Step 3: Implement the minimal pure helpers**

Implement the exact interfaces above without DOM or Electron dependencies. `modeView` maps:

```js
const MODES = {
  adversarial: { label: "Enabled", description: "AI Reviewer decides each request using your instructions." },
  ask: { label: "Ask every time", description: "You decide every request in an approval window." },
  approve: { label: "Approve everything", description: "Every request runs without review." },
  deny: { label: "Deny everything", description: "Every request is refused." },
};
```

`flush()` drains both a pending debounce and any queued write. `dispose()` cancels only unsent work after callers have flushed.

- [ ] **Step 4: Run the helper tests green**

Run Step 2. Expected: pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/desktop/src/renderer/gatekeeperState.js apps/desktop/test/gatekeeperState.test.ts
git commit -m "Add Gatekeeper renderer state helpers"
```

### Task 3: Move Gatekeeper policy and stored rules into Audit

**Files:**
- Modify: `apps/desktop/src/renderer/index.html`
- Modify: `apps/desktop/src/renderer/main.js`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/scripts/verify-preload.mjs`
- Modify: `apps/desktop/scripts/connect-screenshot.mjs`

**Interfaces:**
- Consumes: `modeView`, `createSerialAutosave`, existing `inferenceGet`, `approvalModeSet`, `agentPurposeGet/Set`, `rulesList/Remove`, and `onRulesChanged`.
- Produces: Audit-mounted `gatekeeper` controller with `refreshMode()`, `refreshRules()`, `flushPrompt()`, and `dispose()`.

- [ ] **Step 1: Make the preload probe assert the new Audit ownership**

Change the probe before renderer code so it expects:

```js
{
  noRulesTab: !document.querySelector('#seg button[data-tab="rules"]'),
  gatekeeperInAudit: !!document.querySelector('#view .audit-gatekeeper'),
  title: document.querySelector('.gatekeeper-title')?.textContent === 'Gatekeeper',
  selectedMode: document.querySelector('.gatekeeper-mode')?.textContent.includes('Enabled'),
  promptVisible: !!document.querySelector('.gatekeeper-purpose textarea'),
  rulesModalOpens: /* click View rules and find .rules-modal */,
}
```

Add a probe sequence that types two prompt revisions, waits for `.save-saving`, then `.save-saved`, and confirms `loadSettings(probeHome).agentPurpose` equals the newest text. Retain revoke failure coverage inside the modal.

- [ ] **Step 2: Run the UI probe red**

Run:

```bash
just verify-preload
```

Expected: Rules tab still exists and Audit has no Gatekeeper card.

- [ ] **Step 3: Remove the Rules route and mount the Gatekeeper card in Audit**

In `index.html`, remove `<button data-tab="rules">Rules</button>`.

In `main.js`:

- import helpers from `gatekeeperState.js`;
- move the existing approvals mode, purpose, and rules-list behavior out of `renderRules`;
- build `.audit-gatekeeper` before the existing Audit toolbar;
- render title `Gatekeeper`, a `.gatekeeper-mode` pill/button beside it, `View N rules`, current-mode explanation, and always-visible prompt editor;
- open the existing `openMenu` with all four mode choices and descriptions;
- use serial autosave with a 500ms quiet period and visible Saving/Saved/error state;
- flush the editor before leaving Audit and preserve a failed draft on screen;
- open `.rules-modal` using the app's existing modal furniture, with live list updates and revoke behavior;
- remove `renderRules`, `rulesMounted`, and the `currentTab === "rules"` branch.

In `main.ts`, map stored `rules` to `audit` in `ui:getTab`.

- [ ] **Step 4: Style the approved B layout**

Add scoped classes for:

- `.audit-gatekeeper` white card, title and Enabled status pill;
- menu descriptions and warning treatment for Approve everything;
- full-width prompt textarea and right-aligned save status;
- rules modal list and empty state.

Do not change unrelated tab layouts.

- [ ] **Step 5: Run the UI probe green and inspect its screenshots**

Run Step 2's command. Expected: exit 0. Open generated Gatekeeper/Audit screenshots and verify the card precedes the toolbar, text does not clip, dropdown consequences are readable, and the modal fits the window.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/desktop/src/renderer/index.html apps/desktop/src/renderer/main.js apps/desktop/src/renderer/styles.css apps/desktop/src/main.ts apps/desktop/scripts/verify-preload.mjs apps/desktop/scripts/connect-screenshot.mjs
git commit -m "Move Gatekeeper policy into Audit"
```

### Task 4: Put denial attention in global chrome and Audit detail

**Files:**
- Modify: `apps/desktop/src/gatekeeperRecovery.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/preload.cts`
- Modify: `apps/desktop/src/renderer/index.html`
- Modify: `apps/desktop/src/renderer/main.js`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/test/gatekeeperRecovery.test.ts`
- Modify: `apps/desktop/scripts/verify-preload.mjs`
- Modify: `apps/desktop/scripts/connect-screenshot.mjs`

**Interfaces:**
- Consumes: latest `GatekeeperRecoveryView`, selected `AuditActivityRow.intentId`, and revision coach.
- Produces: `gatekeeperRecovery:dismiss(intentId): GatekeeperRecoveryView | null`; renderer notice controller; detail-pane revision modal.

- [ ] **Step 1: Add failing stale-dismiss and recovery-view tests**

In `gatekeeperRecovery.test.ts`, assert the view has no `state` and keeps `intentId`, request, capabilities, reason. In the preload probe, add two denial fixtures and assert dismissing the old id does not clear the newer denial.

Add DOM assertions that:

```js
const detail = document.querySelector('.gatekeeper-denial-detail');
return {
  suggestPresent: [...detail.querySelectorAll('button')].some((b) => b.textContent === 'Suggest revised instructions'),
  keepAbsent: !detail.textContent.includes('Keep as-is') && !detail.textContent.includes('Keep current instructions'),
  retryAbsent: !detail.textContent.includes('Allow one retry'),
  dismissPresent: !!detail.querySelector('.gatekeeper-denial-dismiss'),
};
```

- [ ] **Step 2: Run recovery tests/probe red**

```bash
npx vitest run apps/desktop/test/gatekeeperRecovery.test.ts
```

Then run the preload probe. Expected: state/old UI assertions fail.

- [ ] **Step 3: Add fenced dismissal in main/preload**

Expose:

```ts
gatekeeperRecoveryDismiss: (intentId: string) => ipcRenderer.invoke("gatekeeperRecovery:dismiss", intentId)
```

The main handler clears attention and emits `gatekeeperRecovery:changed` only when `gatekeeperAttention?.intentId === intentId`; otherwise it returns the newer attention unchanged.

- [ ] **Step 4: Add the global non-Audit notice**

Place one `#gatekeeperNotice` sibling beside `#updateBanner` in `index.html`. Renderer code draws neutral fixed copy plus the request via `textContent`, hides it on Audit, and exposes:

- `Review in Audit →`: select Audit, set `selectedId` to the matching activity id/intent match, refresh, scroll the row into view, and focus detail;
- `×`: call fenced dismiss and redraw without tab navigation.

Refresh the notice on every `gatekeeperRecovery:changed` event and after tab switches.

- [ ] **Step 5: Compose recovery into `detailFor` and preserve suggestion flow**

When `attentionMatches(attention, activity)` is true, prepend an amber `.gatekeeper-denial-detail` with:

```text
Gatekeeper denied this request
Revise Gatekeeper’s instructions if requests like this should be allowed.
Suggest revised instructions
```

Add the top-right `×`. Keep ordinary activity details below it. The action opens a modal immediately, shows a loading state while `gatekeeperRecoverySuggest(intentId)` runs, then displays current instructions and an editable suggested full replacement. **Save instructions** calls `agentPurposeSet`, updates the main card, closes the modal, and dismisses matching attention. Fence asynchronous results by intent id/generation.

- [ ] **Step 6: Route notifications and tray recovery to the exact Audit activity**

Change `onShowGatekeeperRecovery` to select Audit and call the same selection/reveal helper as the global notice. Update notification text to `Open Plow Latch to review it or improve your Gatekeeper instructions.`

- [ ] **Step 7: Run recovery unit/UI tests green and inspect screenshots**

Run Step 2 plus the preload probe/screenshot harness. Inspect:

- neutral notice on a non-Audit tab;
- selected amber denied row and right detail pane;
- suggestion loading/success modal;
- notice/detail disappearance after `×` without row deletion.

- [ ] **Step 8: Commit Task 4**

```bash
git add apps/desktop/src/gatekeeperRecovery.ts apps/desktop/src/main.ts apps/desktop/src/preload.cts apps/desktop/src/renderer/index.html apps/desktop/src/renderer/main.js apps/desktop/src/renderer/styles.css apps/desktop/test/gatekeeperRecovery.test.ts apps/desktop/scripts/verify-preload.mjs apps/desktop/scripts/connect-screenshot.mjs
git commit -m "Move Gatekeeper recovery into Audit"
```

### Task 5: Update documentation and complete regression coverage

**Files:**
- Modify: `DESIGN.md`
- Modify: `README-ts.md`
- Modify: `docs/TESTING-THE-APP.md`
- Modify: `apps/desktop/src/renderer/onboarding-fixtures.js` if its navigation rejection list still names Rules.
- Modify: `apps/desktop/scripts/verify-preload.mjs`
- Modify: `apps/desktop/scripts/connect-screenshot.mjs`
- Modify: `packages/device-core/test/deviceCore.test.ts`
- Modify: `packages/mcp-server/test/toolCopy.test.ts`

**Interfaces:**
- Consumes: completed renderer/main behavior.
- Produces: docs and fixtures that describe one Audit-centered policy surface.

- [ ] **Step 1: Add/adjust negative searches to tests**

Make fixtures reject `Allow one retry`, `Keep as-is`, and a Rules navigation button while requiring `Gatekeeper`, `Enabled`, `Suggest revised instructions`, `Saving…`, and `Saved` in the relevant UI state.

- [ ] **Step 2: Run affected fixture tests red**

```bash
npx vitest run apps/desktop/test packages/device-core/test packages/mcp-server/test
```

Expected: stale fixture/copy expectations fail until updated.

- [ ] **Step 3: Update docs and fixtures from live behavior**

Replace Rules-pane ownership with Audit/Gatekeeper-card ownership. Remove override lifecycle text. Preserve docs describing ordinary approval-window **Allow once**, which is a separate human approval decision and remains supported.

- [ ] **Step 4: Run affected tests green and audit stale terms**

```bash
npx vitest run apps/desktop/test packages/device-core/test packages/mcp-server/test
rg -n "allow one matching retry|Allow one retry|Keep as-is|data-tab=\"rules\"|currentTab === \"rules\"|Rules pane" apps packages docs README-ts.md DESIGN.md
```

Expected: tests pass; search returns only historical/migration explanations that are still true.

- [ ] **Step 5: Commit Task 5**

```bash
git add DESIGN.md README-ts.md docs/TESTING-THE-APP.md apps/desktop packages/device-core packages/mcp-server
git commit -m "Document Audit-centered Gatekeeper controls"
```

### Task 6: Canonical verification, smoke test, and pull request convergence

**Files:**
- No planned production changes; fix only verified failures found by the gates.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: fresh local evidence, pushed branch, open PR, exact-head review/CI convergence, and runtime smoke evidence.

- [ ] **Step 1: Run canonical tests and build**

```bash
just test
just build
```

Expected: both exit 0 with no failing tests or compiler errors.

- [ ] **Step 2: Run UI and Electron smoke tiers**

Run the desktop preload probe and screenshot harness, then the Electron smoke:

```bash
just verify-preload
OUT_DIR=/tmp/plow-latch-latch4 just connect-screenshot
just smoke-electron
```

Expected: exit 0; screenshots prove the specified layouts.

- [ ] **Step 3: Perform requirement-by-requirement evidence audit**

Re-read the spec. For every Product decision, Audit layout, Denial attention, One-time override removal, Error handling, and Verification bullet, name the test, search, screenshot, or runtime observation proving it. Fix missing evidence before continuing.

- [ ] **Step 4: Commit any gate fixes, push, and open/update the PR**

Stage explicit paths only. Push the current feature branch. Verify the base repository is operator-controlled before opening the PR. Put behavior changes at the top of the PR body.

- [ ] **Step 5: Run the `babysit-pr` workflow**

Invoke `$babysit-pr <full PR URL>`. Review and fix real findings, rerun relevant tests, push, and require a clean review on the exact final head plus green required checks. Do not merge without explicit consent for that exact ordinary PR.

- [ ] **Step 6: Smoke test the exact converged head**

Re-fetch the PR head SHA, verify local HEAD matches it, rerun the desktop UI smoke/harness, and inspect fresh screenshots. Record the exact SHA and observable outcomes.

- [ ] **Step 7: Report converged handoff**

Report the exact head, canonical test/build results, smoke evidence, remaining merge-consent requirement, and full PR URL/status in a Links block.
