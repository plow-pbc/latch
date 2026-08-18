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
  modeHint,
  showsPurpose,
} from "../src/renderer/approvals.js";
import type { ApprovalMode } from "../src/settings.js";

const MODES: ApprovalMode[] = ["ask", "adversarial", "approve", "deny"];

describe("approvals card", () => {
  it("keeps the stored mode values while renaming every label", () => {
    expect(APPROVAL_MODES.map((m: { value: string }) => m.value)).toEqual([
      "ask",
      "adversarial",
      "approve",
      "deny",
    ]);
    expect(APPROVAL_MODES.map((m: { label: string }) => m.label)).toEqual([
      "Ask me every time",
      "AI Reviewer decides",
      "Approve everything",
      "Deny everything",
    ]);
  });

  it("says nothing about adversaries anywhere a person reads", () => {
    const copy = [
      ...APPROVAL_MODES.map((m: { label: string }) => m.label),
      PURPOSE_LABEL,
      ...PURPOSE_CAVEATS,
      ...MODES.map((m) => modeHint(m)),
    ].join(" ");
    expect(copy.toLowerCase()).not.toContain("adversarial");
  });

  it("offers the purpose field to the reviewer's mode and no other", () => {
    expect(showsPurpose("adversarial")).toBe(true);
    for (const mode of ["ask", "approve", "deny"]) {
      expect(showsPurpose(mode)).toBe(false);
    }
  });

  it("puts a line where the field is not, and no line where it is", () => {
    // The card is never blank under its chips…
    for (const mode of ["ask", "approve", "deny"]) {
      expect(modeHint(mode).length).toBeGreaterThan(0);
    }
    // …and never says two things at once.
    expect(modeHint("adversarial")).toBe("");
  });

  it("states the bound and the cost beside the purpose field", () => {
    // Both halves, and the honest one is not optional: turning this mode on is
    // what stops the questions, and the card has to say so.
    expect(PURPOSE_CAVEATS).toContain(
      "It can only narrow what gets approved — each approval still lists the capabilities this Mac will enforce.",
    );
    expect(PURPOSE_CAVEATS).toContain("Requests that fit may be approved without asking you.");
  });

  it("points Ask mode at where a suggestion is turned on", () => {
    expect(modeHint("ask")).toContain("Settings");
  });
});
