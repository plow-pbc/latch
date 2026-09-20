import { describe, expect, it } from "vitest";
import { BROWSER_PLUGIN } from "@domo/device-core";
import { pluginExamples } from "../src/onboardingExampleCatalog.js";
import { GATEKEEPER_DECKS, ONBOARDING_EXAMPLES } from "../src/onboardingExamples.js";

describe("onboarding example catalog", () => {
  it("tags the unchanged ten-query Gatekeeper catalog for plugin filtering", () => {
    expect(ONBOARDING_EXAMPLES.map(({ plugins }) => plugins)).toEqual([
      ["gog"],
      ["messages"],
      ["browser"],
      [],
      [],
      ["gog"],
      ["gog"],
      ["gog"],
      [],
      [],
    ]);
    expect(GATEKEEPER_DECKS.home).toEqual(ONBOARDING_EXAMPLES.slice(0, 5));
    expect(GATEKEEPER_DECKS.work).toEqual(ONBOARDING_EXAMPLES.slice(5));
  });

  it("labels the first four queries whose plugins are present", () => {
    expect(pluginExamples([
      { name: "gog", title: "Gmail and Google Calendar" },
      { name: "messages", title: "iMessage history" },
      { name: "wiki", title: "Obsidian-style wiki" },
      { name: BROWSER_PLUGIN, title: "Browser use" },
    ])).toEqual([
      { query: "Check the family calendar", plugins: ["Gmail and Google Calendar"] },
      { query: "Text Mary “Running late”", plugins: ["iMessage history"] },
      { query: "Sign in to Instacart with your password", plugins: ["Browser use"] },
      { query: "Find unread email from your team", plugins: ["Gmail and Google Calendar"] },
    ]);
    expect(pluginExamples([{ name: "wiki", title: "Obsidian-style wiki" }])).toEqual([]);
  });
});
