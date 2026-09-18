import { describe, expect, it } from "vitest";
import { cloudProviderPickerViewModel, deployCards } from "../src/cloudAgentViewModel.js";

describe("cloudProviderPickerViewModel", () => {
  it.each([
    [
      "a list has not loaded",
      null,
      null,
      {
        mode: "blocked",
        heading: "Agent types could not be loaded",
        message: "Agent types couldn't be loaded yet. Try again.",
      },
    ],
    [
      "the live list is empty",
      [],
      null,
      {
        mode: "blocked",
        heading: "No agent types are available",
        message: "Plow has no cloud agent types available right now.",
      },
    ],
    [
      "the first list request failed",
      null,
      "Plow returned 503.",
      {
        mode: "blocked",
        heading: "Agent types could not be loaded",
        message: "Plow couldn't complete that request. Try again.",
      },
    ],
  ] as const)("renders %s", (_case, providers, error, expected) => {
    const providerList = providers === null
      ? null
      : providers.map((id) => ({ id, name: id, phrase: "Start" }));
    expect(cloudProviderPickerViewModel(providerList, error)).toEqual(expected);
  });

  it("renders a populated current list without failure copy", () => {
    expect(cloudProviderPickerViewModel([{ id: "provider/live", name: "Live", phrase: "Start Live" }], null)).toEqual({
      mode: "ready",
      heading: null,
      message: null,
    });
  });
});

describe("deployCards", () => {
  const provider = (id: string, name: string) => ({ id, name, phrase: `Start ${name}` });
  const entry = (users: number, extra: Partial<{ blurb: string | null; builder: string | null; successRate: number | null }> = {}) =>
    ({ blurb: "Does a thing.", builder: "Sam", successRate: 88, users, ...extra });

  it("orders by people, then name, with undescribed agents last", () => {
    const cards = deployCards(
      [provider("hermes", "Hermes"), provider("b", "Bravo"), provider("a", "Alpha"), provider("life", "Life")],
      { life: entry(16), a: entry(2), b: entry(2) },
    );
    expect(cards.map((card) => card.name)).toEqual(["Life", "Alpha", "Bravo", "Hermes"]);
  });

  it.each([
    ["everything, at the rate floor", entry(5, { successRate: 80 }), "by Sam · 5 people · 80% set up"],
    ["no rate below 5 people", entry(4, { successRate: 100 }), "by Sam · 4 people"],
    ["one person", entry(1), "by Sam · 1 person"],
    ["no people part at zero", entry(0), "by Sam"],
    ["no builder", entry(16, { builder: null }), "16 people · 88% set up"],
    ["no rate known", entry(16, { successRate: null }), "by Sam · 16 people"],
  ] as const)("writes the byline with %s", (_case, described, byline) => {
    expect(deployCards([provider("x", "X")], { x: described })[0]?.byline).toBe(byline);
  });

  it("gives an undescribed agent its name only", () => {
    expect(deployCards([provider("hermes", " hermes")], {})).toEqual([
      { id: "hermes", name: " hermes", initial: "H", blurb: null, byline: "No description yet" },
    ]);
  });

  it.each([["🦊 Fox", "🦊"], ["", "?"]])("takes %j's initial as one whole character", (name, initial) => {
    expect(deployCards([provider("x", name)], {})[0]?.initial).toBe(initial);
  });
});
