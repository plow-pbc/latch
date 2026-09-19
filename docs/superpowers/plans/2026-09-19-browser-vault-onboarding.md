# Browser Vault Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the password finish screen with the approved Gatekeeper/browser-cutaway explanation, source both onboarding surfaces from one example registry, and make fresh setup start every plugin on.

**Architecture:** A new typed `onboardingExamples.ts` registry owns all 15 example operations and the ID lists consumed by the Personal deck, Executive deck, and password-screen candidate selector. Main uses the existing adversarial reviewer to choose the first allowed credential-fill outcome and exposes only its display-safe `{ id, prompt, site }` view over preload. The sandboxed renderer draws the approved local SVG logo stack, horizontal Gatekeeper beam, Browser Vault, and browser cutaway without receiving credentials.

**Tech Stack:** TypeScript, Electron IPC/contextBridge, sandboxed vanilla-JS renderer, CSS/SVG, Vitest, Electron screenshot harness

**Spec:** `docs/superpowers/specs/2026-09-19-browser-vault-onboarding-design.md`

## Global Constraints

- Title is exactly `Your agent asks. Plow signs in.`
- Subtitle is exactly `Latch takes care of logging in, so your agent never sees your passwords.`
- The agent stack is above one horizontal Gatekeeper beam; Browser Vault is below-left and Browser is below-right.
- Credential flow is one straight, one-way line from Vault to Browser and never returns above the beam.
- The renderer receives no credential value, credential identifier, operation capabilities, reviewer credential, or reviewer reason for the selected example.
- The browser cutaway shows a masked password and `✓ Signed in`; it does not name the Amazon credit or claim the task is complete.
- Finish actions are `Import passwords` (or the existing Browser-off variant) and `Not now` only.
- Fresh setup starts all plugins on; existing persisted off choices remain off.
- The fixed Personal and Executive Gatekeeper decks remain five rows each with their existing labels, order, operations, and rehearsed verdict populations.
- No remote image, font, script, or stylesheet is loaded by the sandboxed renderer.
- Reduced-motion mode keeps the complete meaning without animation.

---

### Task 1: Canonical onboarding example registry

**Files:**
- Create: `apps/desktop/src/onboardingExamples.ts`
- Create: `apps/desktop/test/onboardingExamples.test.ts`
- Modify: `apps/desktop/src/gatekeeperPreview.ts:1-196`
- Modify: `apps/desktop/test/gatekeeperPreview.test.ts:1-130`

**Interfaces:**
- Consumes: `Capability` and `capabilityDisplay` from `@domo/protocol`.
- Produces: `ExampleId`, `OnboardingExample`, `Operation`, `GATEKEEPER_DECK_IDS`, `FINISH_CANDIDATE_IDS`, `gatekeeperExamples(preset)`, and `finishCandidates()`.
- Preserves: `PRESET_TEXT`, `PresetKey`, `PresetView`, `PreviewResult`, `PreviewDeps`, `gatekeeperPresets()`, and `previewRow()` from `gatekeeperPreview.ts`.

- [ ] **Step 1: Write the registry contract tests**

Create `apps/desktop/test/onboardingExamples.test.ts` with exact inventory and membership assertions:

```ts
import { describe, expect, it } from "vitest";
import {
  EXAMPLES,
  FINISH_CANDIDATE_IDS,
  GATEKEEPER_DECK_IDS,
  finishCandidates,
  gatekeeperExamples,
} from "../src/onboardingExamples.js";

describe("onboarding example registry", () => {
  it("owns the complete fifteen-example inventory once", () => {
    expect(Object.keys(EXAMPLES)).toHaveLength(15);
    expect(Object.values(EXAMPLES).map((example) => example.label)).toEqual([
      "Check the family calendar",
      "Text Mary “Running late”",
      "Sign in to Instacart with your password",
      "Post your tax return publicly",
      "Copy all your saved passwords",
      "Find unread email from your team",
      "Draft a reply to a customer",
      "Find a free hour next week",
      "Review a pull request on GitHub",
      "Read your personal WhatsApp",
      "Pay the mortgages on my rental properties.",
      "Amazon overcharged me for a solar panel—can you get a refund?",
      "Sign in to Kaiser and arrange a dermatology follow-up.",
      "Reschedule my Hipcamp reservations.",
      "Plan dinner with everyone: find a free night, send invitations, book around travel and parking constraints, update the invite, and remove only duplicate reservations.",
    ]);
  });

  it("keeps each fixed Gatekeeper deck at five registry references", () => {
    expect(GATEKEEPER_DECK_IDS.home).toHaveLength(5);
    expect(GATEKEEPER_DECK_IDS.work).toHaveLength(5);
    expect(gatekeeperExamples("home").map((example) => example.label)).toEqual([
      "Check the family calendar",
      "Text Mary “Running late”",
      "Sign in to Instacart with your password",
      "Post your tax return publicly",
      "Copy all your saved passwords",
    ]);
    expect(gatekeeperExamples("work").map((example) => example.label)).toEqual([
      "Find unread email from your team",
      "Draft a reply to a customer",
      "Find a free hour next week",
      "Review a pull request on GitHub",
      "Read your personal WhatsApp",
    ]);
  });

  it("offers only credential-fill outcomes in stable finish order", () => {
    expect(FINISH_CANDIDATE_IDS).toEqual([
      "amazon-refund", "rental-mortgages", "kaiser-follow-up", "hipcamp-reschedule",
    ]);
    expect(finishCandidates().map(({ id, finish }) => [id, finish?.site])).toEqual([
      ["amazon-refund", "Amazon"],
      ["rental-mortgages", "your mortgage servicer"],
      ["kaiser-follow-up", "Kaiser"],
      ["hipcamp-reschedule", "Hipcamp"],
    ]);
    expect(finishCandidates().every((example) =>
      example.operation.capabilities.some((capability) => capability.kind === "credential")
    )).toBe(true);
  });
});
```

- [ ] **Step 2: Run the registry test and verify it fails**

Run:

```bash
npx vitest run apps/desktop/test/onboardingExamples.test.ts
```

Expected: FAIL because `../src/onboardingExamples.js` does not exist.

- [ ] **Step 3: Create the typed registry and move the existing ten operations without changing them**

Create `apps/desktop/src/onboardingExamples.ts`. Move `run`, `SEND_IMESSAGE`, `PREVIEW_HOME`, `INSTACART_LOGIN`, `WHATSAPP_DIR`, `TAX_RETURN`, and the ten current `DECKS` operations from `gatekeeperPreview.ts` into this file byte-for-byte. Give those entries these stable IDs in object insertion order:

```ts
export const GATEKEEPER_DECK_IDS = {
  home: ["family-calendar", "text-mary", "instacart-sign-in", "publish-tax-return", "dump-passwords"],
  work: ["team-unread-email", "customer-draft", "free-hour", "github-review", "personal-whatsapp"],
} as const;
```

Add the common types and accessors:

```ts
import type { Capability } from "@domo/protocol";

export type PresetKey = "home" | "work";
export interface Operation { request: string; capabilities: Capability[] }
export interface FinishExample {
  prompt: string;
  site: string;
}
export interface OnboardingExample {
  id: string;
  label: string;
  icon: string;
  operation: Operation;
  finish?: FinishExample;
}

export const FINISH_CANDIDATE_IDS = [
  "amazon-refund", "rental-mortgages", "kaiser-follow-up", "hipcamp-reschedule",
] as const;

export function gatekeeperExamples(preset: PresetKey): OnboardingExample[] {
  return GATEKEEPER_DECK_IDS[preset].map((id) => EXAMPLES[id]);
}

export function finishCandidates(): OnboardingExample[] {
  return FINISH_CANDIDATE_IDS.map((id) => EXAMPLES[id]);
}
```

Add the five real outcomes after the ten migrated entries. Use fixed preview-only credential IDs and exact capability shapes; they never identify a real vault item or execute:

```ts
const outcomeBrowser = (
  id: string,
  label: string,
  icon: string,
  origins: string[],
  credential: string,
  site: string,
): OnboardingExample => ({
  id, label, icon,
  operation: {
    request: `widen browser session — browse: ${origins.join(", ")}; fill credentials: ${credential}`,
    capabilities: [
      { kind: "browser", origins },
      { kind: "credential", access: "fill", items: [credential] },
    ],
  },
  finish: { prompt: label, site },
});

const realOutcomes: OnboardingExample[] = [
  outcomeBrowser(
    "rental-mortgages",
    "Pay the mortgages on my rental properties.",
    "key",
    ["mortgage.example", "*.mortgage.example"],
    "00000000-0000-4000-8000-000000000011",
    "your mortgage servicer",
  ),
  outcomeBrowser(
    "amazon-refund",
    "Amazon overcharged me for a solar panel—can you get a refund?",
    "key",
    ["amazon.com", "*.amazon.com"],
    "00000000-0000-4000-8000-000000000012",
    "Amazon",
  ),
  outcomeBrowser(
    "kaiser-follow-up",
    "Sign in to Kaiser and arrange a dermatology follow-up.",
    "key",
    ["healthy.kaiserpermanente.org", "*.kaiserpermanente.org"],
    "00000000-0000-4000-8000-000000000013",
    "Kaiser",
  ),
  outcomeBrowser(
    "hipcamp-reschedule",
    "Reschedule my Hipcamp reservations.",
    "key",
    ["hipcamp.com", "*.hipcamp.com"],
    "00000000-0000-4000-8000-000000000014",
    "Hipcamp",
  ),
  {
    id: "coordinate-dinner",
    label: "Plan dinner with everyone: find a free night, send invitations, book around travel and parking constraints, update the invite, and remove only duplicate reservations.",
    icon: "calendar",
    operation: {
      request: "coordinate dinner — calendar, invitations, restaurant research and booking",
      capabilities: [
        { kind: "process.exec", argv: ["plow-gog", "calendar", "events", "list", "--from=now", "--days=30"] },
        { kind: "process.exec", argv: ["plow-gog", "calendar", "events", "create"] },
        { kind: "network", allowed: true },
        { kind: "browser", origins: ["opentable.com", "*.opentable.com"] },
      ],
    },
  },
];
```

Build `EXAMPLES` from the ten migrated rows followed by `realOutcomes`, rejecting duplicate IDs at module construction:

```ts
export const EXAMPLES = Object.fromEntries(
  [...gatekeeperRows, ...realOutcomes].map((example) => [example.id, example]),
) as Record<string, OnboardingExample>;
if (Object.keys(EXAMPLES).length !== gatekeeperRows.length + realOutcomes.length) {
  throw new Error("duplicate onboarding example id");
}
```

- [ ] **Step 4: Refactor Gatekeeper preview to consume registry IDs**

In `gatekeeperPreview.ts`, import `gatekeeperExamples`, `Operation`, and `PresetKey`, then re-export `PresetKey` so the module's public type surface does not move. Delete the moved operation constants and `DECKS`. Build display rows and resolve preview rows from the registry:

```ts
export type { PresetKey } from "./onboardingExamples.js";

export function gatekeeperPresets(): Record<PresetKey, PresetView> {
  const view = (key: PresetKey): PresetView => ({
    text: PRESET_TEXT[key],
    rows: gatekeeperExamples(key).map(({ label, icon, operation }) => ({
      label,
      icon,
      command: operation.capabilities.map(capabilityDisplay),
    })),
  });
  return { home: view("home"), work: view("work") };
}

export async function previewRow(
  preset: unknown,
  index: unknown,
  draft: unknown,
  deps: PreviewDeps,
): Promise<PreviewResult> {
  const rows = preset === "home" || preset === "work" ? gatekeeperExamples(preset) : undefined;
  const row = rows && typeof index === "number" && Number.isInteger(index) ? rows[index] : undefined;
  if (!row) throw new Error("no such preview row");
  return reviewOperation(row.operation, typeof draft === "string" ? draft : "", deps);
}
```

Extract the existing `makeIntent` plus `deps.review` body unchanged into a private `reviewOperation(operation: Operation, purpose: string, deps: PreviewDeps)` helper so Task 2 can reuse it.

- [ ] **Step 5: Run registry and Gatekeeper tests**

Run:

```bash
npx vitest run apps/desktop/test/onboardingExamples.test.ts apps/desktop/test/gatekeeperPreview.test.ts
```

Expected: PASS; the existing request/capability assertions prove the ten migrated probes did not drift.

- [ ] **Step 6: Commit the canonical registry**

```bash
git add apps/desktop/src/onboardingExamples.ts apps/desktop/src/gatekeeperPreview.ts apps/desktop/test/onboardingExamples.test.ts apps/desktop/test/gatekeeperPreview.test.ts
git commit -m "Refactor onboarding examples into one registry"
```

---

### Task 2: Select an actually allowed browser example

**Files:**
- Modify: `apps/desktop/src/gatekeeperPreview.ts`
- Modify: `apps/desktop/test/gatekeeperPreview.test.ts`
- Modify: `apps/desktop/src/main.ts:900-925`
- Modify: `apps/desktop/src/preload.cts:180-190`
- Modify: `apps/desktop/src/renderer/onboarding-dev.js:35-70`
- Modify: `apps/desktop/scripts/onboarding-screenshot.mjs:65-90`

**Interfaces:**
- Consumes: `finishCandidates()` from Task 1 and `PreviewDeps`' existing reviewer boundary.
- Produces: `FinishExampleView = { id: string; prompt: string; site: string }` and `selectAllowedFinishExample(purpose, deps): Promise<FinishExampleView | null>`.
- Exposes: `window.domo.onboardingBrowserExample()` via IPC channel `onboarding:browserExample`.

- [ ] **Step 1: Write failing selector tests**

Append to `gatekeeperPreview.test.ts`:

```ts
import { selectAllowedFinishExample } from "../src/gatekeeperPreview.js";

describe("password finish example", () => {
  it("returns the first allowed credential-fill outcome", async () => {
    const seen: string[] = [];
    const { deps: d } = deps({
      review: async (args) => {
        seen.push(args.intent.request);
        return args.intent.request.includes("amazon.com")
          ? { verdict: "allow", reason: "shopping is allowed" }
          : { verdict: "deny", reason: "not allowed" };
      },
    });
    expect(await selectAllowedFinishExample("Allow online shopping.", d)).toEqual({
      id: "amazon-refund",
      prompt: "Amazon overcharged me for a solar panel—can you get a refund?",
      site: "Amazon",
    });
    expect(seen).toHaveLength(1);
  });

  it("skips denied candidates in stable order", async () => {
    const seen: string[] = [];
    const { deps: d } = deps({
      review: async (args) => {
        seen.push(args.intent.request);
        return args.intent.request.includes("kaiserpermanente.org")
          ? { verdict: "allow", reason: "health care allowed" }
          : { verdict: "deny", reason: "not allowed" };
      },
    });
    expect((await selectAllowedFinishExample("Allow health care.", d))?.id).toBe("kaiser-follow-up");
    expect(seen).toHaveLength(3);
  });

  it.each(["no_credits", "unavailable"] as const)("stops on %s", async (cause) => {
    let calls = 0;
    const { deps: d } = deps({
      review: async () => {
        calls += 1;
        return { verdict: "ask", reason: "could not review", cause };
      },
    });
    expect(await selectAllowedFinishExample("Allow browser work.", d)).toBeNull();
    expect(calls).toBe(1);
  });

  it("returns null when every candidate is refused", async () => {
    const { deps: d } = deps({ review: async () => ({ verdict: "deny", reason: "not allowed" }) });
    expect(await selectAllowedFinishExample("No browser work.", d)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the selector tests and verify they fail**

Run:

```bash
npx vitest run apps/desktop/test/gatekeeperPreview.test.ts
```

Expected: FAIL because `selectAllowedFinishExample` is not exported.

- [ ] **Step 3: Implement stable, fail-quiet selection**

Export the view and selector from `gatekeeperPreview.ts`:

```ts
export interface FinishExampleView {
  id: string;
  prompt: string;
  site: string;
}

export async function selectAllowedFinishExample(
  purpose: string,
  deps: PreviewDeps,
): Promise<FinishExampleView | null> {
  for (const example of finishCandidates()) {
    const result = await reviewOperation(example.operation, purpose, deps);
    if (result.cause) return null;
    if (result.verdict === "allow" && example.finish) {
      return { id: example.id, prompt: example.finish.prompt, site: example.finish.site };
    }
  }
  return null;
}
```

The shared `reviewOperation` must continue to build a preview identity, pass empty history, trim the relay credential, set `humanAvailable: false`, and return only the review result.

- [ ] **Step 4: Add the narrow IPC and preload methods**

In `main.ts`, register beside the existing Gatekeeper preview handlers:

```ts
ipcMain.handle("onboarding:browserExample", async () => {
  const settings = loadSettings(home);
  return selectAllowedFinishExample(settings.agentPurpose ?? "", {
    review: adversarialReview,
    settings,
    apiBaseUrl,
  });
});
```

Add `selectAllowedFinishExample` to the existing import from `gatekeeperPreview.ts`. In `preload.cts`, expose:

```ts
onboardingBrowserExample: () => ipcRenderer.invoke("onboarding:browserExample"),
```

In `onboarding-dev.js`, answer from the selected fixture:

```js
onboardingBrowserExample: async () => selected.browserExample ?? null,
```

In `onboarding-screenshot.mjs`, answer from `currentFixture`:

```js
ipcMain.handle("onboarding:browserExample", async () => currentFixture.browserExample ?? null);
```

- [ ] **Step 5: Verify selector and preload surface**

Run:

```bash
npx vitest run apps/desktop/test/gatekeeperPreview.test.ts
npm run build
```

Expected: PASS and a clean TypeScript build.

- [ ] **Step 6: Commit the selector boundary**

```bash
git add apps/desktop/src/gatekeeperPreview.ts apps/desktop/test/gatekeeperPreview.test.ts apps/desktop/src/main.ts apps/desktop/src/preload.cts apps/desktop/src/renderer/onboarding-dev.js apps/desktop/scripts/onboarding-screenshot.mjs
git commit -m "Choose an allowed browser example for setup"
```

---

### Task 3: Build the approved browser-cutaway finish screen

**Files:**
- Modify: `apps/desktop/src/renderer/onboarding.js:1-45,828-875,1035-1065`
- Modify: `apps/desktop/src/renderer/onboarding.css:948-1055`
- Modify: `apps/desktop/src/renderer/onboarding-fixtures.js:535-580`
- Modify: `apps/desktop/test/onboardingFixtures.test.ts`
- Modify: `apps/desktop/scripts/onboarding-screenshot.mjs:145-195`
- Delete: `apps/desktop/src/renderer/onboardingDone.js`
- Delete: `apps/desktop/test/onboardingDone.test.ts`

**Interfaces:**
- Consumes: `window.domo.onboardingBrowserExample(): Promise<FinishExampleView | null>` and `window.domo.pluginsGet()`.
- Produces: the selected Done DOM, with `.agent-mark-stack`, `.finish-gate`, `.finish-vault`, `.finish-browser`, and `.finish-secret-line` visual regions.
- Removes: the Done screen's Cloud Agents lookup and Text-agent action.

- [ ] **Step 1: Change the Done fixtures first**

Define once near the existing Done fixtures:

```js
const amazonBrowserExample = {
  id: "amazon-refund",
  prompt: "Amazon overcharged me for a solar panel—can you get a refund?",
  site: "Amazon",
};
```

Attach `browserExample: amazonBrowserExample` to `done-agent`, `done-noagent`, `done-browser-off`, and `done-browser-loading`. Replace their text assertions with the new contract:

```js
expect: [
  "Your agent asks. Plow signs in.",
  "Latch takes care of logging in, so your agent never sees your passwords.",
  "Amazon overcharged me for a solar panel—can you get a refund?",
  "Gatekeeper",
  "Browser Vault",
  "Amazon",
  "Signed in",
  "Import passwords",
  "Not now",
],
reject: [
  "Reconcile bank deposits",
  "Negotiate and verify an Amazon credit",
  "Arrange follow-up care",
  "Cancel Hipcamp bookings",
  "Text Elm",
],
expectAriaLabel: "Agents including Claude, OpenAI, and Cursor",
```

Keep the Browser-off fixture's `Enable Browser & import passwords` expectation and the loading fixture's existing disabled-primary assertion.

- [ ] **Step 2: Run the fixture test and verify it fails**

Run:

```bash
npx vitest run apps/desktop/test/onboardingFixtures.test.ts
```

Expected: FAIL because the old screen still renders `Put your passwords to work`, the four outcome cards, and `Text Elm`.

- [ ] **Step 3: Add local agent marks and the browser-cutaway DOM**

At the top of `onboarding.js`, remove `loadDoneAgent` and keep the existing `svgElement` helper. Copy the exact Claude, OpenAI, and Cursor `viewBox="0 0 24 24"` path data from the operator-controlled source at `https://plow.co/build` into three constants. Render them locally:

```js
function agentMark(label, path, square = false) {
  const svg = svgElement("svg", { viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": "true" });
  svg.appendChild(svgElement("path", { d: path }));
  return el("span", { class: `agent-mark${square ? " square" : ""}`, attrs: { title: label } }, [svg]);
}

function agentMarkStack() {
  return el("div", {
    class: "agent-mark-stack",
    attrs: { "aria-label": "Agents including Claude, OpenAI, and Cursor" },
  }, [
    agentMark("Claude", CLAUDE_MARK_PATH),
    agentMark("OpenAI", OPENAI_MARK_PATH),
    agentMark("Cursor", CURSOR_MARK_PATH, true),
  ]);
}
```

Replace `doneScreen()` with the approved structure. Keep the existing Browser-enabled primary-action logic, autofocus, disabled-loading behavior, and `onboardingFinish` destinations unchanged:

```js
function doneScreen() {
  const loadingBrowser = doneBrowserEnabled === null;
  const enablingBrowser = doneBrowserEnabled === false;
  const importPasswords = button(
    enablingBrowser ? "Enable Browser & import passwords" : "Import passwords",
    "nav-next",
    () => update(() => window.domo.onboardingFinish(
      enablingBrowser ? "enable-browser-and-import" : "import",
    )),
  );
  importPasswords.setAttribute("autofocus", "");
  importPasswords.disabled = loadingBrowser;

  const site = doneBrowserExample?.site ?? "Website";
  const prompt = doneBrowserExample?.prompt ?? null;
  const browser = el("div", { class: "finish-browser" }, [
    el("div", { class: "finish-browser-bar", attrs: { "aria-hidden": "true" } }, [el("i"), el("i"), el("i")]),
    el("div", { class: "finish-browser-body" }, [
      el("strong", { text: site }),
      el("div", { class: "finish-password", text: "••••••••••" }),
      el("span", { class: "finish-signed-in", text: "✓ Signed in" }),
    ]),
  ]);

  return el("div", { class: "done-wrap password-finish" }, [
    el("h1", { text: "Your agent asks. Plow signs in." }),
    el("p", { class: "subhead", text: "Latch takes care of logging in, so your agent never sees your passwords." }),
    el("div", { class: "finish-boundary" }, [
      el("div", { class: "finish-agent" }, [agentMarkStack(), prompt ? el("span", { text: `“${prompt}”` }) : null]),
      el("div", { class: "finish-gate" }, [el("span", { text: "Gatekeeper ✓" })]),
      el("div", { class: "finish-local" }, [
        el("div", { class: "finish-vault" }, [icon("key", { strokeWidth: "1.8" }), el("strong", { text: "Browser Vault" })]),
        el("div", { class: "finish-secret-line", attrs: { "aria-hidden": "true" } }),
        browser,
      ]),
    ]),
    el("div", { class: "done-actions" }, [
      importPasswords,
      button("Not now", "done-tertiary", () => update(() => window.domo.onboardingFinish())),
    ]),
  ]);
}
```

Add `let doneBrowserExample = undefined;` beside `doneBrowserEnabled`. On leaving Done reset it to `undefined`. On entering Done, load Browser status first so the button does not wait on model inference, then load the example independently:

```js
void window.domo.pluginsGet().catch(() => null).then((plugins) => {
  if (state?.step !== "done") return;
  const browser = plugins?.rows?.find((row) => row.kind === "Browser");
  doneBrowserEnabled = browser ? browser.status !== "off" : false;
  render();
});
void window.domo.onboardingBrowserExample().catch(() => null).then((example) => {
  if (state?.step !== "done") return;
  doneBrowserExample = example;
  render();
});
```

Delete `onboardingDone.js`, its import, `doneAgent`, the Cloud Agents Done lookup, the Text-agent action, and `onboardingDone.test.ts`.

- [ ] **Step 4: Implement collision-free layout and reduced motion**

Replace the old `.done-key`, `.browser-outcomes`, `.browser-outcome`, and `.outcome-dot` rules. Use an explicit three-row boundary layout so no labels overlap:

```css
.done-wrap.password-finish { max-width: 560px; margin: 0 auto; padding-top: 42px; }
.password-finish h1 { margin-bottom: 12px; font-size: 40px; }
.password-finish .subhead { max-width: 48ch; }
.finish-boundary { position: relative; display: grid; grid-template-rows: 86px 34px 142px; width: 100%; margin-top: 24px; }
.finish-agent { display: flex; align-items: center; justify-content: center; gap: 12px; color: var(--text); font-size: 12px; }
.finish-agent > span:last-child { max-width: 300px; text-align: left; line-height: 1.4; }
.agent-mark-stack { display: inline-flex; align-items: center; flex: none; }
.agent-mark { display: grid; width: 25px; height: 25px; place-items: center; overflow: hidden; border: 1px solid var(--border-2); border-radius: 50%; background: #f7f7f2; color: #111; }
.agent-mark + .agent-mark { margin-left: -6px; }
.agent-mark svg { width: 15px; height: 15px; }
.agent-mark.square { border-color: #111; border-radius: 8px; background: #111; color: #fff; }
.finish-gate { position: relative; display: grid; place-items: center; }
.finish-gate::before { content: ""; position: absolute; right: 0; left: 0; height: 2px; background: linear-gradient(90deg, transparent, var(--volt), #fbffd8, var(--volt), transparent); box-shadow: 0 0 9px var(--volt), 0 0 28px rgba(213,239,138,.35); }
.finish-gate span { position: relative; z-index: 1; padding: 5px 10px; border: 1px solid rgba(213,239,138,.45); border-radius: 999px; background: #11130f; color: var(--volt); font: 9px var(--mono); letter-spacing: .06em; text-transform: uppercase; }
.finish-local { display: grid; grid-template-columns: 132px 1fr 250px; align-items: center; gap: 0; padding: 14px 24px 0; }
.finish-vault { display: grid; min-height: 72px; place-items: center; border: 1px solid rgba(213,239,138,.34); border-radius: 14px; background: rgba(213,239,138,.06); color: var(--volt); }
.finish-vault svg { width: 20px; height: 20px; }
.finish-vault strong { color: var(--text); font-size: 12px; }
.finish-secret-line { height: 2px; background: linear-gradient(90deg, var(--volt), #fbffd8); box-shadow: 0 0 8px rgba(213,239,138,.6); }
.finish-browser { overflow: hidden; border: 1px solid var(--border-2); border-radius: 14px; background: #11130f; text-align: left; }
.finish-browser-bar { display: flex; height: 24px; align-items: center; gap: 4px; padding: 0 9px; border-bottom: 1px solid var(--border); }
.finish-browser-bar i { width: 5px; height: 5px; border-radius: 50%; background: var(--muted); }
.finish-browser-body { padding: 12px 14px; }
.finish-password { height: 24px; margin-top: 8px; padding: 4px 8px; border: 1px solid rgba(213,239,138,.42); border-radius: 6px; color: var(--text); letter-spacing: .16em; }
.finish-signed-in { display: block; margin-top: 7px; color: var(--volt); font-size: 10px; }
.done-actions { margin-top: 22px; }
@media (prefers-reduced-motion: reduce) {
  .finish-gate::before, .finish-secret-line { animation: none !important; }
}
```

- [ ] **Step 5: Strengthen screenshot verification**

In `onboarding-screenshot.mjs`, keep the handoff click assertions and add one structural read for `done-agent` before clicking Import:

```js
const layout = await win.webContents.executeJavaScript(`(() => {
  const agent = document.querySelector(".finish-agent").getBoundingClientRect();
  const gate = document.querySelector(".finish-gate").getBoundingClientRect();
  const vault = document.querySelector(".finish-vault").getBoundingClientRect();
  const browser = document.querySelector(".finish-browser").getBoundingClientRect();
  return {
    agentAbove: agent.bottom <= gate.top,
    localBelow: vault.top >= gate.bottom && browser.top >= gate.bottom,
    vaultLeft: vault.right <= browser.left,
    marks: document.querySelectorAll(".agent-mark-stack .agent-mark").length,
  };
})()`);
if (!layout.agentAbove || !layout.localBelow || !layout.vaultLeft || layout.marks !== 3) {
  throw new Error(`Password boundary layout is wrong: ${JSON.stringify(layout)}`);
}
```

- [ ] **Step 6: Run renderer tests and capture the changed screen**

Run:

```bash
npx vitest run apps/desktop/test/onboardingFixtures.test.ts
just onboarding-screenshots
```

Expected: PASS. Inspect `/tmp/onboarding-done-agent.png`, `/tmp/onboarding-done-browser-off.png`, and `/tmp/onboarding-done-browser-loading.png`; confirm no overlaps or clipping, exactly three stacked marks, agent content wholly above the beam, Vault/browser wholly below, and only the two approved actions.

- [ ] **Step 7: Commit the finish screen**

```bash
git add apps/desktop/src/renderer/onboarding.js apps/desktop/src/renderer/onboarding.css apps/desktop/src/renderer/onboarding-fixtures.js apps/desktop/test/onboardingFixtures.test.ts apps/desktop/scripts/onboarding-screenshot.mjs apps/desktop/src/renderer/onboardingDone.js apps/desktop/test/onboardingDone.test.ts
git commit -m "Explain browser credential fills in setup"
```

---

### Task 4: Default every fresh-setup plugin on

**Files:**
- Modify: `apps/desktop/src/onboarding.ts:140-165,238-252`
- Modify: `apps/desktop/src/main.ts:2450-2475`
- Modify: `apps/desktop/test/onboarding.test.ts:290-345`
- Modify: `apps/desktop/src/renderer/onboarding-fixtures.js:55-105,405-455`
- Modify: `apps/desktop/test/onboardingFixtures.test.ts`

**Interfaces:**
- Consumes: settings' existing `disabledPlugins?: string[]`, where absence means enabled.
- Produces: no new API. Fresh settings naturally render every staged plugin and Browser on; stored disabled names still win.
- Removes: `OnboardingDeps.applyPluginDefault` and its Privacy-transition call.

- [ ] **Step 1: Replace the old defaulting tests with the intended state transition**

Delete the two tests named `defaults the plugins once...` and `keeps the owner on Privacy when the plugin default throws...`. Add:

```ts
it("moves from Privacy to Gatekeeper without rewriting plugin choices", async () => {
  plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
  const before = loadSettings(home);
  before.disabledPlugins = ["messages"];
  saveSettings(home, before);
  const onboarding = build();

  await onboarding.advance();
  await settle();
  expect(onboarding.state().step).toBe("privacy");
  expect((await onboarding.advance()).step).toBe("gatekeeper");
  expect(loadSettings(home).disabledPlugins).toEqual(["messages"]);
});
```

Remove `applyPluginDefault` from the test builder's default dependency object and from the pending-dependency table.

- [ ] **Step 2: Run the state-machine test and verify the interface failure**

Run:

```bash
npx vitest run apps/desktop/test/onboarding.test.ts
```

Expected: FAIL until `OnboardingDeps` and Privacy advancement stop requiring `applyPluginDefault`.

- [ ] **Step 3: Delete the disabling hook without clearing stored choices**

Remove this member from `OnboardingDeps`:

```ts
applyPluginDefault: () => Promise<void>;
```

Replace the Privacy branch with a direct transition:

```ts
if (this.step === "privacy") {
  this.step = "gatekeeper";
  return this.publish();
}
```

Delete the `applyPluginDefault` callback passed by `main.ts`. Do not clear
`settings.disabledPlugins`: an existing owner's explicit off choices must
survive re-setup. Fresh settings already have no disabled names, and
`pluginsNow()` already appends Browser with `enabled: !disabled.has(BROWSER_PLUGIN)`.

- [ ] **Step 4: Make the fresh Plugins fixture prove all rows begin on**

Change the fixture's `rows` helper to accept an explicit Browser status and use `needs-setup` for the fresh setup:

```js
const rows = (gmailStatus, iMessageStatus, fda, browserStatus = "needs-setup") => [
  row("gog", gmail, "Read and draft email; check and book your calendar.", "CLI", gmailStatus, [google]),
  row("messages", iMessage, "Find and read your texts, right on this Mac.", "CLI", iMessageStatus, [fda]),
  row("wiki", "Obsidian-style wiki", "A notebook your agents keep about the people and projects in your life.", "CLI", "ready", []),
  row("browser", "Browser use", "Browse and fill in forms in a private browser, with Safari as a fallback.", "Browser", browserStatus, [fda, safari]),
];
const onlyWiki = { rows: rows("off", "off", fullDisk, "off"), grants: [] };
const picked = {
  rows: rows("needs-setup", "needs-setup", fullDisk),
  grants: [
    { ...fullDisk, plugins: [iMessage, "Browser use"] },
    { ...safari, plugins: ["Browser use"] },
    { ...google, plugins: [gmail] },
  ],
};
```

Update `plugins-fresh` fixture expectations to include `Browser use`, `Required: Safari`, and the Browser switch in its on state. Add a test in `onboardingFixtures.test.ts`:

```ts
it("starts every fresh plugin row on, including Browser", () => {
  const fresh = fixture("plugins-fresh");
  expect(fresh.plugins.rows.map((row) => [row.name, row.status])).toEqual([
    ["gog", "needs-setup"],
    ["messages", "needs-setup"],
    ["wiki", "ready"],
    ["browser", "needs-setup"],
  ]);
});
```

- [ ] **Step 5: Run state, model, and fixture tests**

Run:

```bash
npx vitest run apps/desktop/test/onboarding.test.ts apps/desktop/test/pluginsModel.test.ts apps/desktop/test/onboardingFixtures.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the default-on behavior**

```bash
git add apps/desktop/src/onboarding.ts apps/desktop/src/main.ts apps/desktop/test/onboarding.test.ts apps/desktop/src/renderer/onboarding-fixtures.js apps/desktop/test/onboardingFixtures.test.ts
git commit -m "Default setup plugins and Browser on"
```

---

### Task 5: Canonical gate, documentation, visual evidence, and pull-request convergence

**Files:**
- Modify: `README-ts.md:235-245`
- Modify: `docs/TESTING-THE-APP.md:355-362`
- Verify: all files changed in Tasks 1-4

**Interfaces:**
- Consumes: the completed implementation and repository verification commands.
- Produces: a clean feature branch, captured UI evidence, and an open converged pull request; it does not merge without explicit consent.

- [ ] **Step 1: Run the targeted regression population**

Run:

```bash
npx vitest run \
  apps/desktop/test/onboardingExamples.test.ts \
  apps/desktop/test/gatekeeperPreview.test.ts \
  apps/desktop/test/onboarding.test.ts \
  apps/desktop/test/onboardingFixtures.test.ts \
  apps/desktop/test/pluginsModel.test.ts
```

Expected: PASS with all five test files executed and no skipped new cases.

- [ ] **Step 2: Run the repository's canonical gate**

Run:

```bash
just test
```

Expected: exit 0 after the TypeScript browser-server build and complete Vitest suite.

- [ ] **Step 3: Verify the real preload bridge**

Run:

```bash
just verify-preload
```

Expected: exit 0; the real preload exposes `onboardingBrowserExample` and both
sandboxed renderers boot without throwing.

- [ ] **Step 4: Capture and inspect Electron evidence on the designated M4**

First run:

```bash
hostname
```

Expected in this checkout: `mbp`. Then run:

```bash
just onboarding-screenshots
```

Expected: exit 0 and Done/Plugins PNGs under `/tmp`. Open the resulting
`onboarding-done-agent.png`, `onboarding-done-browser-off.png`,
`onboarding-done-browser-loading.png`, and `onboarding-plugins-fresh.png` and
verify the spec's placement, no overlap/clipping, exact copy, three stacked
logos, Browser-on switch, and correct actions.

- [ ] **Step 5: Drive the changed setup path**

Run the onboarding fixture app, select `gatekeeper-home`, continue through
`plugins-fresh`, and finish on `done-agent`. Type a custom Gatekeeper purpose,
verify the five visible probe rows remain fixed, verify every plugin switch
starts on, and verify the Done example either matches an allowed reviewed
candidate or becomes generic when the reviewer fixture returns no candidate.
Click `Import passwords` and confirm the main window opens Browser Vault's
existing Import sheet. Repeat with `done-browser-off` and confirm the action
enables Browser before opening the same sheet.

- [ ] **Step 6: Update the observable-flow documentation**

In `README-ts.md`, change the last stage in the first-run sequence from `Put
your passwords to work` to `Your agent asks. Plow signs in.` and add one sentence
that Plugins starts every staged plugin, including Browser, on while Access walks
the unmet grants.

In the `Setup: Password import handoff` row of `docs/TESTING-THE-APP.md`, add the
observable visual contract: three overlapping agent marks and the task stay
above the horizontal Gatekeeper beam; Browser Vault and the site stay below;
the only line carrying a password runs from Vault to the browser. Keep the
existing import-destination and Browser-off assertions.

- [ ] **Step 7: Review the diff and commit documentation**

Run:

```bash
git diff --check
git status --short
git diff -- apps/desktop docs README-ts.md
```

Expected: no whitespace errors, no `.superpowers/` brainstorming artifacts
staged, and only scoped implementation/spec/plan/docs changes. Commit the docs:

```bash
git add README-ts.md docs/TESTING-THE-APP.md
git commit -m "Document browser-vault onboarding"
```

- [ ] **Step 8: Push, open the operator-controlled pull request, and converge its exact head**

Run:

```bash
git push -u origin feature/browser-vault-onboarding
gh pr create --base main --head feature/browser-vault-onboarding \
  --title "Explain browser credential fills during setup" \
  --body "Shares one typed registry across Gatekeeper and real outcomes; selects the first browser example allowed by the saved Gatekeeper instructions; replaces the password finish cards with the approved logo-stack, beam, Vault, and browser cutaway; and defaults every fresh-setup plugin on. Verified with targeted Vitest, just test, just verify-preload, onboarding screenshots, and the driven setup handoff."
```

The PR body must summarize the canonical registry, actual Gatekeeper-backed
selection, cutaway credential boundary, default-on plugins, test commands, and
captured Done/Plugins evidence. Immediately run `$babysit-pr <full PR URL>` (or
the equivalent manual review/fix/re-review loop if unavailable) until the exact
head is converged and required checks are green. Do not merge without explicit
consent for that exact PR.
