import { describe, expect, it } from "vitest";
import { cloudProviderPickerViewModel } from "../src/cloudAgentViewModel.js";

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
    [
      "a refresh failed after a list loaded",
      ["provider/live"],
      "Plow didn't answer in time. Try again.",
      {
        mode: "banner",
        heading: "Agent types could not be refreshed",
        message: "Plow didn't answer in time. Try again.",
      },
    ],
  ] as const)("renders %s", (_case, providers, error, expected) => {
    const providerList = providers === null ? null : [...providers];
    expect(cloudProviderPickerViewModel(providerList, error)).toEqual(expected);
  });

  it("renders a populated current list without failure copy", () => {
    expect(cloudProviderPickerViewModel(["provider/live"], null)).toEqual({
      mode: "ready",
      heading: null,
      message: null,
    });
  });
});
