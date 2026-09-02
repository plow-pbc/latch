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
  ] as const)("renders %s", (_case, providers, error, expected) => {
    const providerList = providers === null
      ? null
      : providers.map((id) => ({ id, name: id }));
    expect(cloudProviderPickerViewModel(providerList, error)).toEqual(expected);
  });

  it("renders a populated current list without failure copy", () => {
    expect(cloudProviderPickerViewModel([{ id: "provider/live", name: "Live" }], null)).toEqual({
      mode: "ready",
      heading: null,
      message: null,
    });
  });
});
