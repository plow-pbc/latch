/* The Vault tab's filter. The listing it reads is the vault's own summary, so
   what these prove is the match: every field, any word order, no case, no
   accents — and nothing the summary does not carry. */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS renderer module, shipped as-is (not compiled by tsc)
import { vaultMatches, vaultHaystack } from "../src/renderer/vaultSearch.js";

const card = {
  id: "c",
  title: "Amex",
  type: "card",
  subtitle: "amex · 04/2030",
  urls: [],
  fields: { cardholderName: "Daniel Délattre", brand: "amex", expMonth: "04", expYear: "2030" },
  notes: "the travel one",
  secrets: { number: "371449635398431", code: "1234" },
};
const login = {
  id: "l",
  title: "Notion",
  type: "login",
  subtitle: "me@example.com",
  urls: ["https://www.notion.so/login", "https://notion.example"],
  fields: { username: "me@example.com" },
  notes: "",
  secrets: { password: "correct horse battery" },
};

describe("vaultMatches", () => {
  it("matches everything on an empty or blank query", () => {
    expect(vaultMatches(card, "")).toBe(true);
    expect(vaultMatches(card, "   ")).toBe(true);
    expect(vaultMatches(card, undefined)).toBe(true);
  });

  it("finds an item by any field it carries", () => {
    expect(vaultMatches(card, "amex")).toBe(true);          // title / brand
    expect(vaultMatches(card, "2030")).toBe(true);          // a field
    expect(vaultMatches(card, "travel")).toBe(true);        // notes
    expect(vaultMatches(login, "notion.so")).toBe(true);    // a URL, not only the first
    expect(vaultMatches(login, "notion.example")).toBe(true);
    expect(vaultMatches(login, "@example")).toBe(true);     // the subtitle / username
  });

  it("ignores case and accents", () => {
    expect(vaultMatches(card, "DANIEL")).toBe(true);
    expect(vaultMatches(card, "delattre")).toBe(true);
    expect(vaultMatches(card, "Délattre")).toBe(true);
  });

  it("needs every word, in any order, across any fields", () => {
    expect(vaultMatches(card, "travel amex")).toBe(true);
    expect(vaultMatches(card, "amex   travel")).toBe(true);
    expect(vaultMatches(card, "amex notion")).toBe(false);
  });

  it("finds a type by its name when the pane says what to call it", () => {
    expect(vaultMatches(card, "card", "Card")).toBe(true);
    expect(vaultMatches(card, "card")).toBe(false);
    expect(vaultMatches(login, "secure note", "Login")).toBe(false);
  });

  it("finds an item by a secret the listing carries", () => {
    expect(vaultMatches(login, "horse")).toBe(true);
    expect(vaultMatches(card, "4319")).toBe(false);
    expect(vaultMatches(card, "9843")).toBe(true);
  });

  it("does not match what it was not given", () => {
    expect(vaultMatches(login, "hunter2")).toBe(false);
    expect(vaultMatches({ ...login, secrets: {} }, "horse")).toBe(false); // a gated item lists none
    expect(vaultMatches({ id: "x", title: "bare" }, "bare")).toBe(true); // an old summary shape still works
    expect(vaultMatches({ id: "x", title: "bare" }, "other")).toBe(false);
  });
});

describe("vaultHaystack", () => {
  it("is the strings of the summary and nothing else", () => {
    expect(vaultHaystack(card, "Card")).toEqual([
      "Amex", "amex · 04/2030", "Daniel Délattre", "amex", "04", "2030", "371449635398431", "1234", "the travel one", "Card",
    ]);
  });
});
