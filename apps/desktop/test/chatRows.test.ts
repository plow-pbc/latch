import { describe, expect, it } from "vitest";
import { chatRowEntries, chatRowTitle, formatNumber, type ChatPerson } from "../src/chatRows.js";

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

describe("the chat row's entries", () => {
  it.each([
    [
      "pairs each name with its own number, the line first",
      { line: LINE, lineName: "Willow", people: [person({ isOwner: true }), person({ number: "+12018051467", name: "Nina" })] },
      [
        { label: "Willow", number: "+1 650-315-6536" },
        { label: "You", number: "+1 330-554-1942" },
        { label: "Nina", number: "+1 201-805-1467" },
      ],
    ],
    [
      "stands a number in for anyone without a name, on both halves",
      { line: LINE, lineName: null, people: [person({ number: "+19165204946" })] },
      [
        { label: "+1 650-315-6536", number: "+1 650-315-6536" },
        { label: "+1 916-520-4946", number: "+1 916-520-4946" },
      ],
    ],
    [
      "lists the line once, even when a participant is on it",
      { line: LINE, lineName: "Willow", people: [person({ number: LINE })] },
      [{ label: "Willow", number: "+1 650-315-6536" }],
    ],
    ["is empty when there is no line and nobody to name", { line: null, lineName: null, people: [] }, []],
  ])("%s", (_case, { line, lineName, people }, expected) => {
    expect(chatRowEntries(line, lineName, people)).toEqual(expected);
  });

  it("keeps a name containing the flat separator in ONE entry", () => {
    // The row used to be two strings joined on " · " and read by position, so
    // a line Plow names "Willow · Home" added a fourth apparent name above
    // three numbers. An entry is an object: a separator in a name is a name.
    const entries = chatRowEntries(LINE, "Willow · Home", [
      person({ isOwner: true }),
      person({ number: "+12018051467", name: "Smith · John" }),
    ]);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ label: "Willow · Home", number: "+1 650-315-6536" });
    expect(entries[2]).toEqual({ label: "Smith · John", number: "+1 201-805-1467" });
  });
});
