import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { grantList } from "../src/pluginsModel.js";
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

  // Read from the source, so a renamed step can't leave a fixture rendering
  // "This setup step is unavailable." in place of the screen it names.
  it("shows only steps onboarding.ts declares", () => {
    const source = fs.readFileSync(new URL("../src/onboarding.ts", import.meta.url), "utf8");
    const union = source.match(/export type OnboardingStep =([^;]+);/)![1]!;
    const steps = [...union.matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(fixtures.filter((f) => !steps.includes(f.state.step)).map((f) => f.name)).toEqual([]);
  });

  it("gives every plugin fixture the grant list the model makes of its rows", () => {
    const withPlugins = fixtures.filter((f) => f.plugins);
    expect(withPlugins.length).toBeGreaterThan(0);
    for (const f of withPlugins) expect(f.plugins.grants, f.name).toEqual(grantList(f.plugins.rows));
  });
});
