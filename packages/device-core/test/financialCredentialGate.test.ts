/**
 * Pure unit coverage of the financial DETECTION function.
 *
 * `isFinancialDestination` decides whether a device-observed destination host is
 * a bank, and therefore whether the release must carry an owner payment
 * approval. The ENFORCEMENT that consumes that approval (fail-closed on every
 * non-approval) is exercised end to end through the fake browser + fake vault
 * broker in `fillSecretMasking.test.ts`, so it is not duplicated here.
 */
import { describe, expect, it } from "vitest";
import { isFinancialDestination } from "@domo/device-core";

describe("isFinancialDestination", () => {
  it.each([
    { what: "a bank domain", host: "chase.com", financial: true },
    { what: "a subdomain of a bank", host: "secure.chase.com", financial: true },
    { what: "sofi.com, named in the spec", host: "sofi.com", financial: true },
    { what: "hsbc.com, a bank the interim list must now cover", host: "hsbc.com", financial: true },
    { what: "an unrelated site", host: "pizza.example", financial: false },
    // A look-alike must NOT match: suffix matching is on label boundaries.
    { what: "a look-alike that only ends in the name", host: "notchase.com", financial: false },
    { what: "a bank name used as a subdomain of another site", host: "chase.com.evil.com", financial: false },
  ])("classifies $what: $financial", ({ host, financial }) => {
    expect(isFinancialDestination(host)).toBe(financial);
  });
});
