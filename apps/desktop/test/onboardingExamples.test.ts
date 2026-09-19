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
      "amazon-refund",
      "rental-mortgages",
      "kaiser-follow-up",
      "hipcamp-reschedule",
    ]);
    expect(finishCandidates().map(({ id, finish }) => [id, finish?.site])).toEqual([
      ["amazon-refund", "Amazon"],
      ["rental-mortgages", "your mortgage servicer"],
      ["kaiser-follow-up", "Kaiser"],
      ["hipcamp-reschedule", "Hipcamp"],
    ]);
    expect(finishCandidates().every((example) =>
      example.operation.capabilities.some((capability) => capability.kind === "credential"),
    )).toBe(true);
  });
});
