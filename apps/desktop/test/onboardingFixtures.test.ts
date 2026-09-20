import { describe, expect, it } from "vitest";
import { gatekeeperPresets } from "../src/gatekeeperPreview.js";
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

  it("gives every plugin fixture the grant list the model makes of its rows", () => {
    const withPlugins = fixtures.filter((f) => f.plugins);
    expect(withPlugins.length).toBeGreaterThan(0);
    for (const f of withPlugins) expect(f.plugins.grants, f.name).toEqual(grantList(f.plugins.rows));
  });

  it("draws the gatekeeper from the presets main serves", () => {
    const withGatekeeper = fixtures.filter((f) => f.gatekeeper);
    expect(withGatekeeper.map((f) => f.name).sort()).toEqual([
      "gatekeeper-checking",
      "gatekeeper-couldnt-check",
      "gatekeeper-custom",
      "gatekeeper-home",
      "gatekeeper-stopped",
      "gatekeeper-work",
    ]);
    const presets = gatekeeperPresets();
    for (const f of withGatekeeper) expect(f.gatekeeper.presets, f.name).toEqual(presets);
  });

  it("gives every Done fixture the same display-safe browser example", () => {
    const done = fixtures.filter((f) => f.state?.step === "done");
    expect(done).toHaveLength(5);
    for (const f of done) {
      if (!f.browserExamplePending) {
        expect(f.browserExample).toEqual({
          prompt: "Amazon overcharged me for a solar panel—can you get a refund?",
          site: "Amazon",
        });
      }
      expect(f.expectAriaLabel).toBe("Agents including Claude, OpenAI, and Cursor");
    }
  });

  it("starts every fresh plugin row on, including Browser", () => {
    const fresh = fixture("plugins-fresh");
    expect(fresh.plugins.rows.map((row) => [row.name, row.status])).toEqual([
      ["gog", "needs-setup"],
      ["messages", "needs-setup"],
      ["wiki", "ready"],
      ["browser", "needs-setup"],
    ]);
  });

  it("carries the shared Back contract into browser previews", () => {
    const reversible = new Set(["activate", "waiting", "gatekeeper", "plugins", "access", "availability"]);

    for (const item of fixtures) {
      expect(item.state.canGoBack, item.name).toBe(reversible.has(item.state.step));
    }
  });
});
