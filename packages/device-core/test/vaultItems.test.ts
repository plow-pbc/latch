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
  staleEdit,
  decryptField,
  decryptHaystack,
  decryptItem,
  decryptSummary,
  encryptCipher,
  splitKey,
  type Cipher,
} from "@domo/device-core";
import { decString, encString } from "../src/browser/vaultCrypto.js";

const account = splitKey(crypto.randomBytes(64));

/** A custom field as a migrated item carries one: under the item's own key. */
function custom(cipher: Cipher, name: string, value: string, type: number) {
  const key = splitKey(decString(cipher.key as string, account.enc, account.mac));
  const enc = (v: string) => encString(Buffer.from(v, "utf8"), key.enc, key.mac);
  return { name: enc(name), value: enc(value), type };
}

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

  it("puts every string, secrets included, in the haystack the search reads", () => {
    // The search runs in main, so the haystack may hold what the listing may
    // not: the owner wants a password to find its item.
    const hay = decryptHaystack({ ...cipher, id: "x" }, account);
    expect(hay).toEqual(expect.arrayContaining(["GitHub", "hunter2", "JBSWY3DPEHPK3PXP", "Login"]));
    expect(hay).toContain("https://github.com");
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

  it("writes only the rows that changed, and drops the ones emptied", () => {
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
    const edit = (urls) =>
      encryptCipher({ itemId: "item-1", ...(urls ? { urls } : { username: "new" }) }, stored, account);

    // Changed: only the row that changed is written anew; the others are the
    // objects they were, match rule and all.
    const changed = edit(["https://a.example/login", "https://b.example", "https://c.example"]);
    expect(changed.login.uris.slice(1)).toEqual([B, C]);
    expect(changed.login.uris[0].match).toBeNull();

    // Removed: the emptied row travels as a blank holding its place, so the
    // rows below it still line up with the entries that belong to them.
    expect(edit(["https://a.example", "", "https://c.example"]).login.uris).toEqual([A, C]);

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

  it("refuses a save composed on a version of the item that is gone", () => {
    const opened = { ...encryptCipher({ type: "login", name: "n", password: "x", urls: ["https://a.example"] }, null, account), id: "item-1", revisionDate: "2026-08-20T04:00:00Z" };
    // Someone else wrote the item while the form sat open.
    const now = { ...opened, revisionDate: "2026-08-20T04:05:00Z" };

    // It is not given the fields at all: what moved is the item, so every
    // field the form is showing is suspect, not only the URL list.
    expect(staleEdit(now, "2026-08-20T04:00:00Z")).toBe(true);
    // Still the version the form was opened on: nothing to refuse.
    expect(staleEdit(now, "2026-08-20T04:05:00Z")).toBe(false);
    // An edit that names no revision made no claim about what it saw, which is
    // no better a position; only a new item is exempt.
    expect(staleEdit(now, undefined)).toBe(true);
    expect(staleEdit(null, undefined)).toBe(false);
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
  it("is refused as a form, and listed as an inert row rather than failing the vault", () => {
    // The enum reserves 5-8, and a migrated vault can hold a 5; showing one
    // as a login would take an edit and write it nowhere. But the LISTING
    // must survive it: the only other way into the vault is gone, so one such
    // item failing the whole list would read as a lost vault.
    const sshKey = { ...encryptCipher({ type: "login", name: "server", password: "x", urls: ["https://a.example"] }, null, account), id: "k", type: 5 };
    expect(() => decryptItem(sshKey, account)).toThrow(/cannot edit item type 5/);
    expect(() => encryptCipher({ itemId: "k", name: "server" }, sshKey, account)).toThrow(/cannot edit item type 5/);
    expect(decryptSummary(sshKey, account)).toEqual({
      id: "k",
      title: "server", // its name still decrypts; hidden reads as lost
      type: "unsupported",
      subtitle: "",
      urls: [],
    });
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

  it("stores a card's expiry parts normalised and refuses a bad one", () => {
    const cipher = encryptCipher({ type: "card", name: "Visa", number: "4111111111111111", expMonth: "4", expYear: "31" }, null, account);
    const item = decryptItem({ ...cipher, id: "c" }, account);
    expect(item.fields.expMonth).toBe("04");
    expect(item.fields.expYear).toBe("2031");
    expect(decryptSummary({ ...cipher, id: "c" }, account).subtitle).toBe("04/2031");
    expect(() => encryptCipher({ type: "card", name: "Visa", expMonth: "13" }, null, account)).toThrow(/card expiry/);
    expect(() => encryptCipher({ type: "card", name: "Visa", expYear: "" }, null, account)).not.toThrow();
  });

  it("searches a card by its number and a migrated item by its custom fields", () => {
    const cipher = { ...encryptCipher(
      { type: "card", name: "Amex", cardholderName: "Daniel Delattre", brand: "amex", number: "371449635398431", code: "1234", notes: "the travel one" },
      null,
      account,
    ), id: "c" };
    expect(decryptHaystack(cipher, account)).toEqual(expect.arrayContaining(
      ["Amex", "Daniel Delattre", "amex", "371449635398431", "1234", "the travel one", "Card"]));
    // A custom field survives migration and an edit but no form shows it —
    // the search is the one place the owner can still reach it by.
    const withCustom = { ...cipher, fields: [custom(cipher, "Member no", "M-77", 0)] };
    expect(decryptHaystack(withCustom, account)).toEqual(expect.arrayContaining(["Member no", "M-77"]));
  });

  it("searches a migrated SSH key by its fingerprint and public key", () => {
    // The forms refuse a type 5, so the search is the one way its owner can
    // reach it by content. Its body sits where migration put it, under the
    // item's own key.
    const login = encryptCipher({ type: "login", name: "deploy key", password: "x" }, null, account);
    const key = splitKey(decString(login.key as string, account.enc, account.mac));
    const enc = (v: string) => encString(Buffer.from(v, "utf8"), key.enc, key.mac);
    const sshKey = { ...login, id: "k", type: 5, login: undefined, sshKey: {
      privateKey: enc("-----BEGIN OPENSSH PRIVATE KEY-----"), publicKey: enc("ssh-ed25519 AAAAC3 jon@mac"), keyFingerprint: enc("SHA256:abc123"),
    } };
    const hay = decryptHaystack(sshKey, account);
    expect(hay).toEqual(expect.arrayContaining(["deploy key", "ssh-ed25519 AAAAC3 jon@mac", "SHA256:abc123", "-----BEGIN OPENSSH PRIVATE KEY-----"]));
    expect(hay).not.toContain("Unsupported");
    // Gated: the key material is a secret, the rest still finds it.
    const gated = decryptHaystack({ ...sshKey, reprompt: 1 }, account);
    expect(gated).toEqual(expect.arrayContaining(["deploy key", "ssh-ed25519 AAAAC3 jon@mac", "SHA256:abc123"]));
    expect(gated).not.toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
    // The enum's 6-8 carry their body verbatim under legacyData: searchable
    // when open, a secret whole when gated.
    const passport = { ...login, id: "p", type: 7, login: undefined, legacyData: { number: enc("P1234567"), country: enc("US") } };
    expect(decryptHaystack(passport, account)).toEqual(expect.arrayContaining(["P1234567", "US"]));
    expect(decryptHaystack({ ...passport, reprompt: 1 }, account)).not.toContain("P1234567");
  });

  it("leaves the secrets of an item that asks for the owner out of the haystack", () => {
    // A search hit is an oracle — type a guess, see whether the row stays —
    // so an item that demands proof of presence before a reveal must demand
    // it before a match too. Its open fields still find it.
    const cipher = { ...encryptCipher({ type: "login", name: "Bank", username: "me", password: "hunter2", urls: ["https://bank.example"] }, null, account), id: "b", reprompt: 1 };
    const hidden = custom(cipher, "PIN", "9876", 1);
    const open = custom(cipher, "Branch", "Downtown", 0);
    const hay = decryptHaystack({ ...cipher, fields: [hidden, open] }, account);
    expect(hay).toEqual(expect.arrayContaining(["Bank", "me", "https://bank.example", "PIN", "Branch", "Downtown"]));
    expect(hay).not.toContain("hunter2");
    expect(hay).not.toContain("9876");
  });

  it("keeps an identity's SSN back and its date of birth readable", () => {
    const cipher = encryptCipher(
      { type: "identity", name: "Me", firstName: "Daniel", lastName: "Delattre", ssn: "000-00-0000", birthDate: "1984-11-09" },
      null,
      account,
    );
    const item = decryptItem({ ...cipher, id: "i" }, account);
    expect(item.fields.firstName).toBe("Daniel");
    expect(item.fields.birthDate).toBe("1984-11-09");
    expect(item.fields.ssn).toBeNull();
    expect(decryptSummary({ ...cipher, id: "i" }, account).subtitle).toBe("Daniel Delattre");
    expect(decryptField(cipher, account, "ssn")).toBe("000-00-0000");
  });

  it("refuses a date of birth that is not YYYY-MM-DD", () => {
    expect(() =>
      encryptCipher({ type: "identity", name: "Me", birthDate: "11/09/1984" }, null, account),
    ).toThrow(/YYYY-MM-DD/);
    // Empty clears it; that is not a bad date.
    expect(() => encryptCipher({ type: "identity", name: "Me", birthDate: "" }, null, account)).not.toThrow();
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
