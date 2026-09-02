import { describe, expect, it } from "vitest";
import { formatDate } from "../src/browser/dateFormat.js";

describe("formatDate", () => {
  it.each([
    ["YYYY-MM-DD", "1984-11-09"],
    ["MM/DD/YYYY", "11/09/1984"],
    ["M/D/YY", "11/9/84"],
    ["DD.MM.YYYY", "09.11.1984"],
    ["MMMM Do, YYYY", "November 9th, 1984"],
    ["MMM D YYYY", "Nov 9 1984"],
    ["MMMM", "November"],
    ["M", "11"],
    ["YYYY", "1984"],
    ["D", "9"],
  ])("renders %s as %s", (pattern, expected) => {
    expect(formatDate("1984-11-09", pattern)).toBe(expected);
  });

  it.each([
    ["2000-05-01", "M", "5"],
    ["2000-05-01", "Do", "1st"],
    ["2000-05-02", "Do", "2nd"],
    ["2000-05-03", "Do", "3rd"],
    ["2000-05-11", "Do", "11th"],
    ["2000-05-12", "Do", "12th"],
    ["2000-05-13", "Do", "13th"],
    ["2000-05-21", "Do", "21st"],
    ["2000-05-22", "Do", "22nd"],
    ["2000-05-23", "Do", "23rd"],
    ["2000-05-31", "Do", "31st"],
  ])("%s with %s is %s", (iso, pattern, expected) => {
    expect(formatDate(iso, pattern)).toBe(expected);
  });

  it("refuses a letter that is not a token", () => {
    expect(() => formatDate("1984-11-09", "MM/DD/YYYY at hh")).toThrow(/h/);
    expect(() => formatDate("1984-11-09", "YYYYY")).toThrow();
  });

  it("refuses a date that is not ISO YYYY-MM-DD", () => {
    expect(() => formatDate("11/09/1984", "YYYY")).toThrow(/YYYY-MM-DD/);
    expect(() => formatDate("1984-13-09", "YYYY")).toThrow(/YYYY-MM-DD/);
    expect(() => formatDate("1984-02-30", "YYYY")).toThrow(/YYYY-MM-DD/);
  });

  it("handles years 0–99 without spurious rejection", () => {
    expect(formatDate("0050-01-01", "YYYY-MM-DD")).toBe("0050-01-01");
    expect(formatDate("0001-12-25", "MMMM Do, YYYY")).toBe("December 25th, 0001");
  });
});
