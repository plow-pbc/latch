/**
 * The setup screens in order — one row per footer dot, and the whole
 * vocabulary of where a relaunch may resume.
 *
 * One table, because two things count setup screens and they used to drift:
 * the footer's dots (hardcoded indices in the renderer) and the resume
 * checkpoint (a single literal step in settings). Add a screen here and it
 * gets both; nothing else counts steps.
 *
 * `resumable: false` marks a screen a relaunch must NOT return to. The
 * activation screen holds a secret that lives in memory and never on disk, so
 * a resumed setup pointing at it would show a code it cannot redeem.
 *
 * Pure on purpose: `settings.ts` types its persisted field from here, and
 * `settings.ts` is read by the test suite and by `latch-smoke`, neither of
 * which runs Electron.
 */
export const SETUP_STEPS = [
  { step: "activate", resumable: false },
  { step: "privacy", resumable: true },
  { step: "gatekeeper", resumable: true },
  { step: "plugins", resumable: true },
  { step: "access", resumable: true },
  { step: "availability", resumable: true },
] as const;

/** A setup screen that owns a dot. `welcome` and `done` have none. */
export type SetupStep = (typeof SETUP_STEPS)[number]["step"];

/** A screen a relaunch may resume on. */
export type ResumableStep = Extract<
  (typeof SETUP_STEPS)[number],
  { resumable: true }
>["step"];

/** How far along the footer reads. */
export interface SetupProgress {
  index: number;
  total: number;
}

/**
 * The dot this step lights, or null for a screen with no dots at all.
 *
 * Takes a plain string: the persisted checkpoint and the renderer's state both
 * arrive from outside the type system, and an unknown step must answer rather
 * than throw.
 */
export function setupProgress(step: string): SetupProgress | null {
  // `waiting` is the activation screen still waiting on the text, not a screen
  // of its own — it shares the dot.
  const key = step === "waiting" ? "activate" : step;
  const index = SETUP_STEPS.findIndex((entry) => entry.step === key);
  return index < 0 ? null : { index, total: SETUP_STEPS.length };
}

/** Whether a relaunch may resume on this step. */
export function isResumableStep(step: string): step is ResumableStep {
  return SETUP_STEPS.some((entry) => entry.step === step && entry.resumable);
}

/**
 * The one source of truth for both the Back affordance and its destination.
 *
 * Deliberately NOT derived from `SETUP_STEPS` order: it deviates in three of
 * six cases and the deviations are the point. There is no Back from Privacy —
 * the code behind it has been redeemed — Availability goes back past Access
 * because Access may have been skipped, and the activation screen goes back to
 * Welcome, which owns no dot and is not in the table.
 */
export function canGoBackFrom(step: string): SetupStep | "welcome" | null {
  if (step === "activate" || step === "waiting") return "welcome";
  if (step === "gatekeeper") return "privacy";
  if (step === "plugins") return "gatekeeper";
  if (step === "access" || step === "availability") return "plugins";
  return null;
}
