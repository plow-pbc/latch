import { describe, expect, it } from "vitest";
import { expiryIso, expiryPart, formatDate } from "../src/browser/dateFormat.js";

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

describe("a month-only date", () => {
  it.each([
    ["MM/YY", "04/31"],
    ["MM/YYYY", "04/2031"],
    ["MMMM YYYY", "April 2031"],
    ["M", "4"],
    ["YYYY-MM", "2031-04"],
  ])("renders %s as %s", (pattern, expected) => {
    expect(formatDate("2031-04", pattern)).toBe(expected);
  });
  it.each(["DD", "MM/DD/YYYY", "Do"])("refuses %s, which needs a day", (pattern) => {
    expect(() => formatDate("2031-04", pattern)).toThrow(/no day/);
  });
  it("still refuses a shape that is neither", () => {
    expect(() => formatDate("2031-4", "MM")).toThrow(/YYYY-MM-DD/);
    expect(() => formatDate("2031-13", "MM")).toThrow(/YYYY-MM-DD/);
  });
});

describe("card expiry parts", () => {
  it.each([
    ["expMonth", "4", "04"], ["expMonth", "12", "12"], ["expMonth", "04", "04"],
    ["expYear", "31", "2031"], ["expYear", "2031", "2031"],
  ] as const)("%s %s stores as %s", (part, given, stored) => {
    expect(expiryPart(part, given)).toBe(stored);
  });
  it.each([
    ["expMonth", "0"], ["expMonth", "13"], ["expMonth", "Apr"], ["expYear", "1"], ["expYear", "203"], ["expYear", "20311"],
  ] as const)("refuses %s %s", (part, given) => {
    expect(() => expiryPart(part, given)).toThrow(/card expiry/);
  });
  it("composes the ISO month, or nothing", () => {
    expect(expiryIso("4", "31")).toBe("2031-04");
    expect(expiryIso("04", "2031")).toBe("2031-04");
    expect(expiryIso("", "2031")).toBeNull();
    expect(expiryIso("04", null)).toBeNull();
    expect(expiryIso("13", "2031")).toBeNull();
  });
});
