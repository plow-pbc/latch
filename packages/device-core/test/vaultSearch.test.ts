/* The Vault tab's matcher, on its own: every string, any word order, no
   case, no accents — and nothing it was not given. */
import { describe, expect, it } from "vitest";
import { haystackMatches, searchWords } from "../src/browser/vaultSearch.js";

const card = ["Amex", "Daniel Délattre", "amex", "04", "2030", "371449635398431", "the travel one", "Card"];
const m = (hay: string[], q: string) => haystackMatches(hay, searchWords(q));

describe("searchWords", () => {
  it("is the folded words of the query, or none for a blank one", () => {
    expect(searchWords("")).toEqual([]);
    expect(searchWords("   ")).toEqual([]);
    expect(searchWords("  Amex  Délattre ")).toEqual(["amex", "delattre"]);
  });
});

describe("haystackMatches", () => {
  it("matches everything on no words", () => {
    expect(m(card, "")).toBe(true);
    expect(m([], "")).toBe(true);
  });

  it("finds a string by any part of it, ignoring case and accents", () => {
    expect(m(card, "travel")).toBe(true);
    expect(m(card, "9843")).toBe(true);
    expect(m(card, "DANIEL")).toBe(true);
    expect(m(card, "delattre")).toBe(true);
    expect(m(card, "Délattre")).toBe(true);
    expect(m(card, "card")).toBe(true);
  });

  it("needs every word, in any order, across any strings", () => {
    expect(m(card, "travel amex")).toBe(true);
    expect(m(card, "amex   travel")).toBe(true);
    expect(m(card, "amex notion")).toBe(false);
  });

  it("does not match what it was not given", () => {
    expect(m(card, "hunter2")).toBe(false);
    expect(m([], "a")).toBe(false);
  });
});
