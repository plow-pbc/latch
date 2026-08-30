import { describe, expect, it } from "vitest";
import { chatRowTitle, formatNumber, type ChatPerson } from "../src/chatRows.js";

const LINE = "+16503156536";
const person = (over: Partial<ChatPerson> = {}): ChatPerson => ({
  number: "+13305541942",
  name: null,
  isOwner: false,
  ...over,
});

describe("formatNumber", () => {
  it("spells a NANP number the way a human reads it", () => {
    expect(formatNumber("+16503156536")).toBe("+1 650-315-6536");
  });

  it.each([
    ["a longer country code", "+442071838750"],
    ["something that is not a number", "not a number"],
    ["an empty string", ""],
  ])("returns %s verbatim rather than mis-grouping it", (_why, raw) => {
    // Chopping an unknown shape into NANP groups would print a number that
    // does not exist, which is worse than printing the one we were given.
    expect(formatNumber(raw)).toBe(raw.trim());
  });
});

describe("the chat row's title", () => {
  it.each([
    [
      "leads with the line's name, then the people",
      { line: LINE, lineName: "Willow", people: [person({ isOwner: true }), person({ number: "+12018051467", name: "Nina" })] },
      "Willow · You · Nina",
    ],
    [
      "stands a number in for anyone without a name",
      { line: LINE, lineName: "Ash", people: [person({ isOwner: true }), person({ number: "+19165204946" })] },
      "Ash · You · +1 916-520-4946",
    ],
    [
      "uses the line's own number when Plow has not named it",
      { line: LINE, lineName: null, people: [person({ isOwner: true })] },
      "+1 650-315-6536 · You",
    ],
    [
      "names the owner You, from the API's own role",
      { line: null, lineName: null, people: [person({ isOwner: true })] },
      "You",
    ],
    [
      "lists the line once, even when a participant is on it",
      {
        line: LINE,
        lineName: "Willow",
        people: [person({ number: LINE, name: "Willow" }), person({ number: "+19165204946", name: "Robin" })],
      },
      "Willow · Robin",
    ],
    ["falls back when there is nothing at all to name", { line: null, lineName: null, people: [] }, "cht_abc"],
  ])("%s", (_case, { line, lineName, people }, expected) => {
    expect(chatRowTitle(people, line, "cht_abc", lineName)).toBe(expected);
  });
});
