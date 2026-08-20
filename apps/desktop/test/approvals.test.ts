/**
 * The Approvals card's copy and shape — the part of it that is a decision
 * rather than a DOM tree.
 *
 * Two things are worth holding still here. The chip labels are display only:
 * the stored `ApprovalMode` values are what settings.json has always held and
 * what `RuleKey`/policy code reads, so a rename that reaches them is a silent
 * migration. And the purpose field appears for exactly one mode — the one whose
 * reviewer is the only thing that reads the text.
 */
import { describe, expect, it } from "vitest";
import { APPROVAL_MODES, PURPOSE_CAVEATS, PURPOSE_LABEL } from "../src/renderer/approvals.js";

interface Mode {
  value: string;
  label: string;
  showsPurpose: boolean;
  hint: string;
}
const modes = APPROVAL_MODES as Mode[];
const mode = (value: string) => modes.find((m) => m.value === value)!;

describe("approvals card", () => {
  it("keeps the stored mode values while renaming every label", () => {
    expect(modes.map((m) => m.value)).toEqual([
      "ask",
      "adversarial",
      "approve",
      "deny",
    ]);
    expect(modes.map((m) => m.label)).toEqual([
      "Ask me every time",
      "AI Reviewer decides",
      "Approve everything",
      "Deny everything",
    ]);
  });

  it("says nothing about adversaries anywhere a person reads", () => {
    const copy = [
      ...modes.map((m) => m.label),
      PURPOSE_LABEL,
      ...PURPOSE_CAVEATS,
      ...modes.map((m) => m.hint),
    ].join(" ");
    expect(copy.toLowerCase()).not.toContain("adversarial");
  });

  it("offers the purpose field to the reviewer's mode and no other", () => {
    expect(mode("adversarial").showsPurpose).toBe(true);
    for (const value of ["ask", "approve", "deny"]) {
      expect(mode(value).showsPurpose).toBe(false);
    }
  });

  it("puts a line where the field is not, and no line where it is", () => {
    // The card is never blank under its chips…
    for (const value of ["ask", "approve", "deny"]) {
      expect(mode(value).hint.length).toBeGreaterThan(0);
    }
    // …and never says two things at once.
    expect(mode("adversarial").hint).toBe("");
  });

  it("states the bound and the cost beside the purpose field", () => {
    // Both halves, and the honest one is not optional: turning this mode on is
    // what stops the questions, and the card has to say so.
    expect(PURPOSE_CAVEATS).toContain(
      "It can only narrow what gets approved — each approval still lists the capabilities this Mac will enforce.",
    );
    expect(PURPOSE_CAVEATS).toContain("Requests that fit may be approved without asking you.");
  });

  it("points Ask mode at the suggestions toggle in its own card", () => {
    // The toggle used to live in Settings, and the hint sent people there. It
    // is a row of this card now, so the sentence must not send anyone to a pane
    // that no longer has one.
    expect(mode("ask").hint).toContain("turn that on below");
    expect(mode("ask").hint).not.toContain("Settings");
  });
});
