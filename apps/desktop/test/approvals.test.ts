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
import {
  APPROVAL_MODES,
  PURPOSE_CAVEATS,
  PURPOSE_LABEL,
  PURPOSE_PLACEHOLDER,
} from "../src/renderer/approvals.js";

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
    //
    // The first line used to promise the purpose could "only narrow what gets
    // approved". It cannot, and the owner should not be told it can: an owner
    // who writes "Manage my SSH keys" has just widened the job to include them.
    expect(PURPOSE_CAVEATS).toContain(
      "It describes the errand — it can widen what gets approved as easily as narrow it. Each approval still lists the capabilities this Mac will enforce.",
    );
    expect(PURPOSE_CAVEATS.join(" ")).not.toContain("only narrow");
    expect(PURPOSE_CAVEATS).toContain("Requests that fit may be approved without asking you.");
  });

  it("models an explicit boundary in the purpose example", () => {
    expect(PURPOSE_PLACEHOLDER).toContain("Instacart grocery ordering and delivery tracking");
    expect(PURPOSE_PLACEHOLDER).toContain("signing in to instacart.com with my saved login");
    expect(PURPOSE_PLACEHOLDER).not.toMatch(/DoorDash|Product Hunt/);
    expect(PURPOSE_PLACEHOLDER).toMatch(
      /You have no business with anything else on this computer — no files, no other sites\.$/,
    );
  });

  it("points Ask mode at the suggestions toggle in its own card", () => {
    // The toggle used to live in Settings, and the hint sent people there. It
    // is a row of this card now, so the sentence must not send anyone to a pane
    // that no longer has one.
    expect(mode("ask").hint).toContain("turn that on below");
    expect(mode("ask").hint).not.toContain("Settings");
  });
});
