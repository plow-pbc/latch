/** The purpose field's own label, which carries its explanation with it. */
export const PURPOSE_LABEL =
  "What are agents for? The reviewer checks each request it sees against this.";

/** An example that demonstrates both the work to allow and the boundary around it. */
export const PURPOSE_PLACEHOLDER =
  "For example: You manage Instacart grocery ordering and delivery tracking on my behalf, including signing in to instacart.com with my saved login. You have no business with anything else on this computer — no files, no other sites.";

/**
 * What has to be said next to that field, both halves of it.
 *
 * The first line used to promise this could "only narrow what gets approved",
 * which was not true and was not even the useful direction. Describing the work
 * WIDENS it: an owner who writes "manage my SSH keys" has told the reviewer
 * that reading those keys is the job, and the old sentence promised them the
 * opposite of what the field does. So it says what it is — the errand — and
 * leaves the enforced bound where the bound actually is, on each approval card.
 * The second is the cost, said plainly rather than left to be discovered:
 * turning this mode on is what stops the questions.
 */
export const PURPOSE_CAVEATS = [
  "It describes the errand — it can widen what gets approved as easily as narrow it. Each approval still lists the capabilities this Mac will enforce.",
  "Requests that fit may be approved without asking you.",
];
