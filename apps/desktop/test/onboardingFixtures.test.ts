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

  it("shows the from-source login-item note only on the from-source availability capture", () => {
    const note = "Only the installed app can add itself as a login item";
    expect(fixture("availability").reject).toContainEqual(expect.stringContaining(note));
    expect(fixture("availability-from-source").expect).toContainEqual(expect.stringContaining(note));
    for (const name of ["availability", "availability-from-source"]) {
      expect(fixture(name).expect).toContain("Keep this Mac reachable");
      expect(fixture(name).expectDotCount).toBe(5);
    }
    expect(fixture("connect-empty").expectDotCount).toBe(5);
  });
});
