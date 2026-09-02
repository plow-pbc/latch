/**
 * The Brand box fills itself from the card number (renderer/vault.js). Two
 * things under test: the reading — a number IS its brand, and the form says
 * nothing rather than guessing when the digits do not name one — and the rule
 * that decides whether the box is still ours to write.
 */
import { describe, expect, it } from "vitest";
import { cardBrand, wireCardBrand } from "../src/renderer/vault.js";

describe("cardBrand", () => {
  it.each([
    { case: "a Visa", input: "4242424242424242", expected: "Visa" },
    { case: "one digit of a Visa, which is already decisive", input: "4", expected: "Visa" },
    { case: "a Mastercard", input: "5555555555554444", expected: "Mastercard" },
    { case: "the low edge of the Mastercard 2-series", input: "2221000000000009", expected: "Mastercard" },
    { case: "the high edge of the 2-series", input: "2720990000000000", expected: "Mastercard" },
    { case: "just below the 2-series", input: "2220000000000000", expected: "" },
    { case: "just above the 2-series", input: "2721000000000000", expected: "" },
    { case: "an Amex 37", input: "378282246310005", expected: "Amex" },
    { case: "an Amex 34", input: "341111111111111", expected: "Amex" },
    { case: "a Discover 6011", input: "6011111111111117", expected: "Discover" },
    { case: "a Discover 644-649", input: "6445000000000000", expected: "Discover" },
    { case: "a Discover 65", input: "6521000000000000", expected: "Discover" },
    // Discover's block inside 62 — read by prefix alone these come out UnionPay.
    { case: "the low edge of Discover's 62 block", input: "6221260000000000", expected: "Discover" },
    { case: "the high edge of that block", input: "6229250000000000", expected: "Discover" },
    { case: "just below it", input: "6221250000000000", expected: "UnionPay" },
    { case: "just above it", input: "6229260000000000", expected: "UnionPay" },
    { case: "a UnionPay", input: "6212345678901232", expected: "UnionPay" },
    { case: "a Diners 36", input: "36227206271667", expected: "Diners Club" },
    { case: "a Diners 300-305", input: "30569309025904", expected: "Diners Club" },
    { case: "a Diners 39", input: "3900000000000000", expected: "Diners Club" },
    { case: "just above the Diners 300-305 range", input: "3060000000000000", expected: "" },
    { case: "a JCB", input: "3530111333300000", expected: "JCB" },
    { case: "the low edge of the JCB range", input: "3528000000000000", expected: "JCB" },
    { case: "the high edge of it", input: "3589000000000000", expected: "JCB" },
    { case: "just below it", input: "3527000000000000", expected: "" },
    { case: "just above it", input: "3590000000000000", expected: "" },
    { case: "an unissued range", input: "1234567890123456", expected: "" },
    { case: "nothing typed", input: "", expected: "" },
    { case: "whitespace only", input: "   ", expected: "" },
    // Typed the way a human types it, and the way a paste arrives.
    { case: "a Visa in groups", input: "4242 4242 4242 4242", expected: "Visa" },
    { case: "an Amex with hyphens", input: "3782-822463-10005", expected: "Amex" },
  ])("reads $case as $expected", ({ input, expected }) => {
    expect(cardBrand(input)).toBe(expected);
  });
});

/** A box that behaves like the form's, without a DOM: a value and an event. */
class Box extends EventTarget {
  value = "";
  type(value: string) {
    this.value = value;
    this.dispatchEvent(new Event("input"));
  }
}

describe("wireCardBrand", () => {
  const form = () => {
    const number = new Box();
    const brand = new Box();
    const ctx = { inputs: { brand }, derivedBrand: "" };
    wireCardBrand(number as unknown as HTMLInputElement, ctx);
    return { number, brand, ctx };
  };

  it("fills the Brand box as the number is typed, and settles as it decides", () => {
    const { number, brand } = form();
    number.type("4");
    expect(brand.value).toBe("Visa");
    // A prefix that is not yet decisive reads as the range it is in and is
    // rewritten on every keystroke, so it never sits on the wrong brand.
    number.type("62212");
    expect(brand.value).toBe("UnionPay");
    number.type("622126");
    expect(brand.value).toBe("Discover");
  });

  it("never overwrites a brand the owner typed", () => {
    const { number, brand } = form();
    number.type("4242");
    brand.value = "My airline card";
    number.type("4242424242424242");
    expect(brand.value).toBe("My airline card");
  });

  it("takes a cleared box as the owner saying no brand", () => {
    const { number, brand } = form();
    number.type("4242");
    brand.value = "";
    number.type("4242424242424242");
    expect(brand.value).toBe("");
  });

  it("leaves a saved card's stored brand alone", () => {
    const { number, brand } = form();
    brand.value = "Visa";
    number.type("378282246310005");
    expect(brand.value).toBe("Visa");
  });
});
