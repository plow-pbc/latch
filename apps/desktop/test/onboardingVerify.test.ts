import { describe, expect, it } from "vitest";
import { verifyIdlePresentation } from "../src/renderer/onboardingVerify.js";

describe("Verify screen without an activation code", () => {
  it("has one loading status instead of a second generic Plow status", () => {
    expect(verifyIdlePresentation({ busy: true, message: "" })).toEqual({
      kind: "loading",
      text: "Getting a code from Plow…",
      action: null,
    });
  });

  it("has one failure sentence and one primary recovery action", () => {
    expect(verifyIdlePresentation({
      busy: false,
      message: "Plow isn’t responding right now.",
    })).toEqual({
      kind: "failure",
      text: "Plow isn’t responding right now.",
      action: "Try again",
    });
  });
});
