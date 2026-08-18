/**
 * The vault's items, encrypted and read back.
 *
 * This is the code that replaced the command-line tool, so it is the code that
 * can lose a secret: everything below is a round trip through the real
 * encryption, checking both that a value survives it and that the values which
 * are supposed to stay hidden actually do.
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkedUrls,
  decryptField,
  decryptItem,
  decryptSummary,
  encryptCipher,
  splitKey,
} from "@domo/device-core";

const account = splitKey(crypto.randomBytes(64));

describe("a login", () => {
  const cipher = encryptCipher(
    {
      type: "login",
      name: "GitHub",
      username: "daniel@plow.co",
      password: "hunter2",
      totp: "JBSWY3DPEHPK3PXP",
      urls: ["https://github.com"],
      notes: "the work account",
    },
    null,
    account,
  );

  it("comes back as it went in", () => {
    const item = decryptItem({ ...cipher, id: "item-1" }, account);
    expect(item).toMatchObject({
      id: "item-1",
      name: "GitHub",
      type: "login",
      notes: "the work account",
      urls: ["https://github.com"],
      fields: { username: "daniel@plow.co", password: null, totp: null },
      secrets: ["password", "totp"],
    });
  });

  it("keeps its secrets out of the item and the listing", () => {
    const both = JSON.stringify([
      decryptItem({ ...cipher, id: "x" }, account),
      decryptSummary({ ...cipher, id: "x" }, account),
    ]);
    expect(both).not.toContain("hunter2");
    expect(both).not.toContain("JBSWY3DPEHPK3PXP");
  });

  it("hands one over when it is asked for by name", () => {
    expect(decryptField(cipher, account, "password")).toBe("hunter2");
    expect(decryptField(cipher, account, "totp")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("is stored under its own key, wrapped with the account key", () => {
    expect(cipher.key).toMatch(/^2\./);
    // Nothing readable with the account key alone — that is what a wrapped
    // item key means.
    expect(() => decryptField({ ...cipher, key: null }, account, "password")).toThrow();
  });
});

describe("an edit", () => {
  const first = encryptCipher(
    { type: "login", name: "GitHub", username: "old", password: "hunter2", urls: ["https://github.com"] },
    null,
    account,
  );

  it("leaves out what it does not mention, and changes what it does", () => {
    const second = encryptCipher({ itemId: "item-1", username: "new" }, { ...first, id: "item-1" }, account);
    const item = decryptItem({ ...second, id: "item-1" }, account);
    expect(item.fields.username).toBe("new");
    expect(item.name).toBe("GitHub");                       // untouched
    expect(decryptField(second, account, "password")).toBe("hunter2"); // untouched
  });

  it("clears a field that is sent empty", () => {
    const second = encryptCipher({ itemId: "item-1", username: "" }, { ...first, id: "item-1" }, account);
    expect(decryptItem({ ...second, id: "item-1" }, account).fields.username).toBe("");
  });
});

describe("the other three types", () => {
  it("keeps a card's number and code back, and shows the rest", () => {
    const cipher = encryptCipher(
      {
        type: "card",
        name: "Amex",
        cardholderName: "Daniel Delattre",
        brand: "amex",
        number: "371449635398431",
        expMonth: "04",
        expYear: "2030",
        code: "1234",
      },
      null,
      account,
    );
    const item = decryptItem({ ...cipher, id: "c" }, account);
    expect(item.fields).toMatchObject({ cardholderName: "Daniel Delattre", brand: "amex", number: null, code: null });
    expect(item.secrets).toEqual(["number", "code"]);
    expect(decryptField(cipher, account, "number")).toBe("371449635398431");
    expect(decryptSummary({ ...cipher, id: "c" }, account).subtitle).toBe("amex · 04/2030");
  });

  it("keeps an identity's SSN back", () => {
    const cipher = encryptCipher(
      { type: "identity", name: "Me", firstName: "Daniel", lastName: "Delattre", ssn: "000-00-0000" },
      null,
      account,
    );
    const item = decryptItem({ ...cipher, id: "i" }, account);
    expect(item.fields.firstName).toBe("Daniel");
    expect(item.fields.ssn).toBeNull();
    expect(decryptSummary({ ...cipher, id: "i" }, account).subtitle).toBe("Daniel Delattre");
    expect(decryptField(cipher, account, "ssn")).toBe("000-00-0000");
  });

  it("keeps a secure note's body in its notes", () => {
    const cipher = encryptCipher({ type: "note", name: "Wifi", notes: "it is on the router" }, null, account);
    expect(decryptItem({ ...cipher, id: "n" }, account)).toMatchObject({
      type: "note",
      notes: "it is on the router",
      secrets: [],
    });
  });
});

describe("the site a login is saved with", () => {
  it("completes a bare host, because that is what a person types", () => {
    expect(checkedUrls(["Daniel.com"])).toEqual(["https://Daniel.com"]);
  });

  it("keeps a real URL as it is", () => {
    expect(checkedUrls(["https://github.com/login"])).toEqual(["https://github.com/login"]);
  });

  it("refuses a login with no site, which could never be filled", () => {
    expect(() => checkedUrls([])).toThrow(/at least one site URL/);
    expect(() => checkedUrls(["  "])).toThrow(/could not read a site/);
  });
});
