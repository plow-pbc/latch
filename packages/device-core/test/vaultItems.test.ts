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

  it("keeps what the screen never showed", () => {
    // Everything below is real vault data that the Vault tab has no field for.
    // An edit that rebuilt the item from the form alone would delete it.
    const rich = {
      ...first,
      id: "item-1",
      favorite: true,
      reprompt: 1,
      fields: [{ name: "recovery code", value: "2.xx|yy|zz", type: 1 }],
      passwordHistory: [{ password: "2.aa|bb|cc", lastUsedDate: "2026-01-01T00:00:00Z" }],
      folderId: "folder-9",
    };
    const second = encryptCipher({ itemId: "item-1", username: "new" }, rich, account);
    expect(second).toMatchObject({
      favorite: true,
      reprompt: 1,
      fields: rich.fields,
      passwordHistory: rich.passwordHistory,
      folderId: "folder-9",
    });
  });

  it("writes only the URL positions that changed, and drops the ones emptied", () => {
    const many = encryptCipher(
      { type: "login", name: "GitHub", password: "x",
        urls: ["https://a.example", "https://b.example", "https://c.example"] },
      null,
      account,
    );
    // The stored entries carry match rules the form never shows.
    many.login.uris = many.login.uris.map((u, i) => ({ ...u, match: i }));
    const stored = { ...many, id: "item-1" };
    const edit = (urls) => encryptCipher({ itemId: "item-1", ...(urls ? { urls } : { username: "new" }) }, stored, account);

    // Changed: only the first is written anew; the others are the objects they were.
    const changed = edit(["https://a.example/login", "https://b.example", "https://c.example"]);
    expect(changed.login.uris.slice(1)).toEqual(many.login.uris.slice(1));
    expect(changed.login.uris[0].match).toBeNull();

    // Emptied: the middle position still travels, so the third reconciles
    // against its own entry rather than the one above it.
    const dropped = edit(["https://a.example", "", "https://c.example"]);
    expect(dropped.login.uris).toEqual([many.login.uris[0], many.login.uris[2]]);
    expect(decryptItem({ ...dropped, id: "item-1" }, account).urls).toEqual([
      "https://a.example",
      "https://c.example",
    ]);

    // Omitted: an edit that mentions no URL changes none of them.
    expect(edit(null).login.uris).toEqual(many.login.uris);
  });

  it("clears a field that is sent empty", () => {
    const second = encryptCipher({ itemId: "item-1", username: "" }, { ...first, id: "item-1" }, account);
    expect(decryptItem({ ...second, id: "item-1" }, account).fields.username).toBe("");
  });
});

describe("an item this app cannot hold", () => {
  it("is refused rather than shown as an empty login", () => {
    // The vault's enum reserves 5-8 and its web page can create them; showing
    // one as a login would take an edit and write it nowhere.
    const sshKey = { ...encryptCipher({ type: "login", name: "server", password: "x", urls: ["https://a.example"] }, null, account), id: "k", type: 5 };
    expect(() => decryptItem(sshKey, account)).toThrow(/cannot show item type 5/);
    expect(() => decryptSummary(sshKey, account)).toThrow(/cannot show item type 5/);
    expect(() => encryptCipher({ itemId: "k", name: "server" }, sshKey, account)).toThrow(/cannot show item type 5/);
  });
});

describe("an item that asks for the owner", () => {
  it("keeps its reprompt flag through an edit", () => {
    const stored = { ...encryptCipher({ type: "login", name: "Bank", password: "x", urls: ["https://bank.example"] }, null, account), id: "item-1", reprompt: 1 };
    // The flag is the vault's, not this screen's: an edit may not drop it, or
    // the item quietly stops asking.
    expect(encryptCipher({ itemId: "item-1", username: "me" }, stored, account).reprompt).toBe(1);
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
  it.each([
    ["completes a bare host, because that is what a person types", "Daniel.com", "https://Daniel.com"],
    ["keeps a real URL as it is", "https://github.com/login", "https://github.com/login"],
  ])("%s", (_case, typed, stored) => {
    expect(checkedUrls([typed])).toEqual([stored]);
  });

  it("refuses a login with no site, which could never be filled", () => {
    expect(() => checkedUrls([])).toThrow(/at least one site URL/);
    expect(() => checkedUrls(["  "])).toThrow(/could not read a site/);
  });
});
