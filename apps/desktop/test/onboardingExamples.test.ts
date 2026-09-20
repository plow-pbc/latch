import { describe, expect, it } from "vitest";
import { FINISH_CANDIDATES } from "../src/onboardingExamples.js";

describe("onboarding examples", () => {
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
