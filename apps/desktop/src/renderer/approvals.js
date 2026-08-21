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
 * The four modes, in the order they are shown, and everything the card needs to
 * know about each.
 *
 * `value` is the stored `ApprovalMode` and never changes; `label` is what the
 * person reads. The word "adversarial" survives only in the value.
 *
 * `showsPurpose` and `hint` are two halves of one decision and live on the same
 * row as the mode they describe: only the reviewer reads the purpose, so only
 * its mode offers the field, and every other mode puts a sentence where the
 * field is not — a card with nothing under its chips reads as unfinished. They
 * were a predicate and a switch keyed on `value`, which is three places to
 * update when a mode is added and two of them easy to miss.
 */
export const APPROVAL_MODES = [
  {
    value: "ask",
    label: "Ask me every time",
    showsPurpose: false,
    hint: "Any request a rule doesn't already cover opens an approval window. The AI Reviewer can still suggest an answer — turn that on below.",
  },
  {
    value: "adversarial",
    label: "AI Reviewer decides",
    showsPurpose: true,
    hint: "",
  },
  {
    value: "reviewer",
    label: "AI Reviewer decides, but asks me when unsure",
    showsPurpose: true,
    hint: "",
  },
  {
    value: "approve",
    label: "Approve everything",
    showsPurpose: false,
    hint: "Every request is allowed without asking you and without review.",
  },
  {
    value: "deny",
    label: "Deny everything",
    showsPurpose: false,
    hint: "Any request a rule doesn't already cover is refused without asking you.",
  },
];

/** The purpose field's own label, which carries its explanation with it. */
export const PURPOSE_LABEL =
  "What are agents for? The reviewer checks each request it sees against this.";

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
