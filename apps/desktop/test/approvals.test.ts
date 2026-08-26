/**
 * The Approvals card's purpose copy, with no DOM in it.
 */
import { describe, expect, it } from "vitest";
import {
  PURPOSE_CAVEATS,
  PURPOSE_PLACEHOLDER,
} from "../src/renderer/approvals.js";

describe("approvals card", () => {
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
});
