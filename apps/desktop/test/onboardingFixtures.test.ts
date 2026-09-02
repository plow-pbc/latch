import { describe, expect, it } from "vitest";
import { onboardingFixtures } from "../src/renderer/onboarding-fixtures.js";

describe("onboarding visual fixtures", () => {
  const fixtures = onboardingFixtures(1_700_000_000_000);
  const fixture = (name: string) => fixtures.find((item) => item.name === name)!;

  it("keeps clean verification separate from the interactive re-arm capture", () => {
    const verify = fixture("verify");
    const rearm = fixture("verify-rearm");

    expect(verify.expect).toContain("Listening for 4:");
    expect(verify.expect).not.toContainEqual(expect.stringContaining("That code still works"));
    expect(rearm.expect).toContainEqual(expect.stringContaining("That code still works"));
  });

  it("uses identical Welcome copy for the full and repeat entrances", () => {
    const first = fixture("welcome");
    const repeat = fixture("welcome-repeat");

    expect(first.state.welcomeEntrancePlayed).toBe(false);
    expect(repeat.state.welcomeEntrancePlayed).toBe(true);
    expect(repeat.expect).toEqual(first.expect);
    expect(repeat.expectFocus).toBe(first.expectFocus);
    expect(repeat.expectTitle).toBe(first.expectTitle);
    expect(repeat.expectAriaLabel).toBe(first.expectAriaLabel);
  });
});
