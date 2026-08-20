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

  it("keeps the entry an unchanged URL already had, wherever it sits", () => {
    const many = encryptCipher(
      { type: "login", name: "GitHub", password: "x",
        urls: ["https://a.example", "https://b.example", "https://c.example"] },
      null,
      account,
    );
    // The stored entries carry match rules the form never shows.
    many.login.uris = many.login.uris.map((u, i) => ({ ...u, match: i }));
    const stored = { ...many, id: "item-1" };
    const [A, B, C] = many.login.uris;
    const edit = (urls, from = stored) =>
      encryptCipher({ itemId: "item-1", ...(urls ? { urls } : { username: "new" }) }, from, account);

    // Changed: only the one that changed is written anew; the others are the
    // objects they were, match rule and all.
    const changed = edit(["https://a.example/login", "https://b.example", "https://c.example"]);
    expect(changed.login.uris.slice(1)).toEqual([B, C]);
    expect(changed.login.uris[0].match).toBeNull();

    // Removed: the form sends the emptied row as a blank holding its place,
    // and the two that stayed keep their own entries.
    const dropped = edit(["https://a.example", "", "https://c.example"]);
    expect(dropped.login.uris).toEqual([A, C]);

    // Reordered: positions no longer name the same rows, so the address does.
    // Nothing was edited, so nothing is rewritten.
    expect(edit(["https://c.example", "https://a.example", "https://b.example"]).login.uris)
      .toEqual([C, A, B]);

    // Retried: a save whose response was lost, sent again from the still-open
    // form against the item it already wrote and compacted. It has to be a
    // no-op — position 2 no longer exists, and matching on the address is what
    // stops C being recreated with the match rule blanked.
    expect(edit(["https://a.example", "", "https://c.example"], { ...dropped, id: "item-1" }).login.uris)
      .toEqual([A, C]);

    // Listed twice: one stored entry cannot be handed to both.
    const twice = edit(["https://a.example", "https://a.example"]).login.uris;
    expect(twice[0]).toEqual(A);
    expect(twice[1].match).toBeNull();

    // Omitted: an edit that mentions no URL changes none of them.
    expect(edit(null).login.uris).toEqual(many.login.uris);
  });

  it("tells two identical addresses apart by the row they came from", () => {
    // The web vault can store one address twice under different match rules;
    // the form shows two boxes that look the same. Which row the owner removed
    // is the only thing that says which rule survives, and an address alone
    // cannot carry that.
    const url = "https://a.example";
    const both = encryptCipher({ type: "login", name: "n", password: "x", urls: [url, url] }, null, account);
    both.login.uris = both.login.uris.map((u, i) => ({ ...u, match: i }));
    const stored = { ...both, id: "item-1" };
    const rules = (c) => c.login.uris.map((u) => u.match);

    // Removed the first row: the second row's rule is the one that survives.
    expect(rules(encryptCipher({ itemId: "item-1", urls: ["", url] }, stored, account))).toEqual([1]);
    // Removed the second: the first's.
    expect(rules(encryptCipher({ itemId: "item-1", urls: [url, ""] }, stored, account))).toEqual([0]);
    // Neither removed: both keep their own, and neither entry is used twice.
    expect(encryptCipher({ itemId: "item-1", urls: [url, url] }, stored, account).login.uris)
      .toEqual(both.login.uris);
  });

  it("stores every URL with the checksum other clients verify", () => {
    // Every current client silently drops a URL whose checksum is missing on an
    // item that carries its own key — the guard against a server slipping an
    // extra site into a login. Ours all carry one, so a URL written without a
    // checksum is a URL only this app can see: the vault's own page shows none,
    // the CLI lists none, and a fill refuses for want of a site.
    const url = "https://checksummed.example/login";
    const written = encryptCipher({ itemId: "item-1", urls: [url] }, { ...first, id: "item-1" }, account);
    const [entry] = written.login.uris;
    // Read back through the item's own key, which is what decryptField uses.
    const probe = { ...written, login: { ...written.login, username: entry.uriChecksum } };
    expect(decryptField(probe, account, "username")).toBe(
      crypto.createHash("sha256").update(url, "utf8").digest("base64"),
    );

    // An item already stored without one — every login this app wrote before
    // this fix — is repaired the next time it is saved, address and rule intact.
    const legacy = { ...written, id: "item-1", login: { ...written.login, uris: [{ uri: entry.uri, match: 3 }] } };
    const [repaired] = encryptCipher({ itemId: "item-1", urls: [url] }, legacy, account).login.uris;
    expect(repaired.uriChecksum).toBeTruthy();
    expect(repaired.match).toBe(3);
    expect(decryptItem({ ...legacy, login: { ...legacy.login, uris: [repaired] } }, account).urls).toEqual([url]);
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
