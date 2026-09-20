import { describe, expect, it } from "vitest";
import { examplesForPlugins, GATEKEEPER_DECKS, ONBOARDING_EXAMPLES } from "../src/onboardingExamples.js";

describe("onboarding example catalog", () => {
  it("tags the unchanged Gatekeeper examples with the plugins that enable them", () => {
    expect(GATEKEEPER_DECKS.home.map(({ label, plugins }) => [label, plugins])).toEqual([
      ["Check the family calendar", ["gog"]],
      ["Text Mary “Running late”", ["messages"]],
      ["Sign in to Instacart with your password", ["browser"]],
      ["Post your tax return publicly", []],
      ["Copy all your saved passwords", []],
    ]);
    expect(GATEKEEPER_DECKS.work.map(({ label, plugins }) => [label, plugins])).toEqual([
      ["Find unread email from your team", ["gog"]],
      ["Draft a reply to a customer", ["gog"]],
      ["Find a free hour next week", ["gog"]],
      ["Review a pull request on GitHub", []],
      ["Read your personal WhatsApp", []],
    ]);
  });

  it("keeps the ten reusable queries in one ordered catalog", () => {
    expect(ONBOARDING_EXAMPLES.map(({ label }) => label)).toEqual([
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
    ]);
  });

  it("offers only queries whose required plugins are available", () => {
    expect(examplesForPlugins(["gog", "browser"]).map(({ label }) => label)).toEqual([
      "Check the family calendar",
      "Sign in to Instacart with your password",
      "Find unread email from your team",
      "Draft a reply to a customer",
      "Find a free hour next week",
    ]);
    expect(examplesForPlugins(["messages"]).map(({ label }) => label)).toEqual([
      "Text Mary “Running late”",
    ]);
    expect(examplesForPlugins(["wiki"])).toEqual([]);
  });
});
