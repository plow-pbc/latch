/**
 * The Approvals card's vocabulary and copy, with no DOM in it.
 *
 * Two reasons this is not inline in `main.js`. The labels are display only —
 * the values below are what settings.json has always stored, and renaming a
 * chip must never become a settings migration — so keeping the pair side by
 * side is what makes that visible. And the card's shape is a decision per mode
 * (a field, or a sentence instead of it), which is the kind of thing a test can
 * hold still without a window.
 */

/**
 * The four modes, in the order they are shown.
 *
 * `value` is the stored `ApprovalMode` and never changes; `label` is what the
 * person reads. The word "adversarial" survives only in the value.
 */
export const APPROVAL_MODES = [
  { value: "ask", label: "Ask me every time" },
  { value: "adversarial", label: "AI Reviewer decides" },
  { value: "approve", label: "Approve everything" },
  { value: "deny", label: "Deny everything" },
];

/** The purpose field's own label, which carries its explanation with it. */
export const PURPOSE_LABEL =
  "What are agents for? The reviewer checks every request against this.";

/**
 * What has to be said next to that field, both halves of it.
 *
 * The first line is the bound: a purpose can only narrow what gets approved,
 * and the enforced capability list on each approval is still the thing that
 * decides. The second is the cost, said plainly rather than left to be
 * discovered — turning this mode on is what stops the questions.
 */
export const PURPOSE_CAVEATS = [
  "It can only narrow what gets approved — each approval still lists the capabilities this Mac will enforce.",
  "Requests that fit may be approved without asking you.",
];

/** Only the reviewer reads the purpose, so only its mode offers the field. */
export function showsPurpose(mode) {
  return mode === "adversarial";
}

/**
 * The line that stands in for the field in every other mode.
 *
 * A card with nothing under the chips reads as unfinished; each of these says
 * what the selected mode actually does when an agent asks for something.
 */
export function modeHint(mode) {
  switch (mode) {
    case "ask":
      return "Every request opens an approval window. The AI Reviewer can still suggest an answer — turn that on in Settings.";
    case "approve":
      return "Every request is allowed without asking you and without review.";
    case "deny":
      return "Every request is refused without asking you.";
    default:
      return "";
  }
}
