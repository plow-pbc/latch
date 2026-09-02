/**
 * The Brand box fills itself from the card number (renderer/vault.js). What is
 * under test is the reading, not the box: a number IS its brand, and the form
 * must say nothing rather than guess when the digits do not name one.
 */
import { describe, expect, it } from "vitest";
import { cardBrand } from "../src/renderer/vault.js";

describe("cardBrand", () => {
  it.each([
    ["4242424242424242", "Visa"],
    ["4", "Visa"],
    ["5555555555554444", "Mastercard"],
    ["2221000000000009", "Mastercard"],
    ["2720990000000000", "Mastercard"],
    ["378282246310005", "American Express"],
    ["341111111111111", "American Express"],
    ["6011111111111117", "Discover"],
    ["6445000000000000", "Discover"],
    ["6521000000000000", "Discover"],
    ["36227206271667", "Diners Club"],
    ["30569309025904", "Diners Club"],
    ["3530111333300000", "JCB"],
    ["3528000000000000", "JCB"],
    ["3589000000000000", "JCB"],
    ["6212345678901232", "UnionPay"],
    // Discover's block inside 62 — mislabelled UnionPay if read by prefix alone.
    ["6221260000000000", "Discover"],
    ["6229250000000000", "Discover"],
    ["3900000000000000", "Diners Club"],
    // Typed the way a human types it, and the way a paste arrives.
    ["4242 4242 4242 4242", "Visa"],
    ["3782-822463-10005", "American Express"],
  ])("reads %s as %s", (number, brand) => {
    expect(cardBrand(number)).toBe(brand);
  });

  it.each([
    ["", "nothing typed"],
    ["   ", "whitespace only"],
    ["1234567890123456", "an unissued range"],
    ["2220000000000000", "just below the Mastercard 2-series"],
    ["2721000000000000", "just above the Mastercard 2-series"],
    ["3060000000000000", "just above the Diners 300-305 range"],
    ["3527000000000000", "just below the JCB range"],
    ["3590000000000000", "just above the JCB range"],
    ["22", "a half-typed 2-series, still ambiguous"],
  ])("names no brand for %s (%s)", (number) => {
    expect(cardBrand(number)).toBe("");
  });

  // A prefix that is not yet decisive reads as the range it is in and settles
  // as the rest arrives — the box is rewritten on every keystroke, so a
  // half-typed number is never left holding the wrong brand.
  it("settles once the number is long enough to decide", () => {
    expect(cardBrand("62212")).toBe("UnionPay");
    expect(cardBrand("622125")).toBe("UnionPay");
    expect(cardBrand("622126")).toBe("Discover");
    expect(cardBrand("622926")).toBe("UnionPay");
  });

  it("names no brand for a null or undefined box", () => {
    expect(cardBrand(null)).toBe("");
    expect(cardBrand(undefined)).toBe("");
  });
});
