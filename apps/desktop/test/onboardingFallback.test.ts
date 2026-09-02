import { describe, expect, it } from "vitest";
import {
  FALLBACK_STATE,
  ONBOARDING_FAILURE_MESSAGE,
  failedOnboardingState,
  resolveOnboardingState,
} from "../src/renderer/onboardingFallback.js";

describe("the onboarding renderer bootstrap fallback", () => {
  it("uses a legible Welcome state when the first state response is null", () => {
    expect(resolveOnboardingState(null, null)).toEqual(FALLBACK_STATE);
  });

  it("uses the same Welcome fallback with an error when the first request rejects", () => {
    expect(failedOnboardingState(null)).toEqual({
      ...FALLBACK_STATE,
      message: ONBOARDING_FAILURE_MESSAGE,
      noteKind: "error",
    });
  });
});
