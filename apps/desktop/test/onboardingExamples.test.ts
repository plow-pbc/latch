import { describe, expect, it } from "vitest";
import {
  FINISH_CANDIDATES,
  GATEKEEPER_DECKS,
} from "../src/onboardingExamples.js";

describe("onboarding examples", () => {
  it("keeps each fixed Gatekeeper deck at five examples", () => {
    expect(GATEKEEPER_DECKS.home.map((example) => example.label)).toEqual([
      "Check the family calendar",
      "Text Mary “Running late”",
      "Sign in to Instacart with your password",
      "Post your tax return publicly",
      "Copy all your saved passwords",
    ]);
    expect(GATEKEEPER_DECKS.work.map((example) => example.label)).toEqual([
      "Find unread email from your team",
      "Draft a reply to a customer",
      "Find a free hour next week",
      "Review a pull request on GitHub",
      "Read your personal WhatsApp",
    ]);
  });

  it("offers only credential-fill outcomes in stable finish order", () => {
    expect(FINISH_CANDIDATES.map((example) => example.finish?.site)).toEqual([
      "Amazon",
      "your mortgage servicer",
      "Kaiser",
      "Hipcamp",
    ]);
    expect(FINISH_CANDIDATES.every((example) =>
      example.operation.capabilities.some((capability) => capability.kind === "credential"),
    )).toBe(true);
  });
});
