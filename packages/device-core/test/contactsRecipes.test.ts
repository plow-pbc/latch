/**
 * The Contacts recipes, RUN.
 *
 * Same reasoning as `imessageRecipes.test.ts` next to this file: "the body
 * contains this substring" cannot tell a working query from a broken one.
 * Every test here builds an AddressBook-shaped database, runs the exact text
 * the agent is handed, and asserts on the rows that come back.
 *
 * What this does NOT cover, so nobody reads more into a green run than is
 * there: the schema below is one this file invents from a live
 * `AddressBook-v22.abcddb` inspection (2026-08-28, macOS 14 on the mba) —
 * only the tables and columns the queries touch. The SQL semantics are
 * executed; the column NAMES are still only as good as that inspection.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONTACTS_NAME_PLACEHOLDER,
  CONTACTS_QUERIES,
  CONTACTS_RECORD_PLACEHOLDER,
  contactsStorePath,
} from "@domo/device-core";

const SQLITE = "/usr/bin/sqlite3";

const sqlite = (args: string[]): string =>
  execFileSync(SQLITE, args, { encoding: "utf8", stdio: "pipe" });

/** Run SQL read-only and hand back rows split into cells — `-list`, not the
 *  `-csv` the skill teaches, for the same reason the sibling tests choose it:
 *  the recipes under test are the SQL, not the output format. */
function query(store: string, sql: string): string[][] {
  const out = sqlite(["-readonly", "-list", store, sql]).trim();
  return out === "" ? [] : out.split("\n").map((line) => line.split("|"));
}

/** The CoreData label constant exactly as the live store spells it — the
 *  `$!` that made the incident's shell round mangle it. */
const HOME_LABEL = "_$!<Home>!$_";

/**
 * A store shaped like AddressBook-v22.abcddb: one record table and the three
 * value tables the skill names, each joined back through `ZOWNER = Z_PK`.
 *
 * Record 1 has a phone, an email and a home address; record 2 has an
 * apostrophe in her name (the parameterization guidance's test case) and no
 * address; record 3 is organization-only, the way company cards really are.
 */
function makeStore(dir: string): string {
  const store = contactsStorePath(dir);
  fs.mkdirSync(path.dirname(store), { recursive: true });
  sqlite([
    store,
    [
      "create table ZABCDRECORD (Z_PK integer primary key, ZFIRSTNAME text," +
        " ZLASTNAME text, ZNAME text, ZNICKNAME text, ZORGANIZATION text);",
      "create table ZABCDPOSTALADDRESS (Z_PK integer primary key, ZOWNER integer," +
        " ZLABEL text, ZSTREET text, ZCITY text, ZSTATE text, ZZIPCODE text," +
        " ZCOUNTRYNAME text);",
      "create table ZABCDPHONENUMBER (Z_PK integer primary key, ZOWNER integer," +
        " ZLABEL text, ZFULLNUMBER text);",
      "create table ZABCDEMAILADDRESS (Z_PK integer primary key, ZOWNER integer," +
        " ZLABEL text, ZADDRESS text);",

      "insert into ZABCDRECORD values (1, 'John', 'Appleseed', 'John Appleseed', NULL, NULL);",
      "insert into ZABCDRECORD values (2, 'Mia', 'O''Brien', 'Mia O''Brien', 'Mo', NULL);",
      "insert into ZABCDRECORD values (3, NULL, NULL, 'Acme Anvils', NULL, 'Acme Anvils');",

      `insert into ZABCDPOSTALADDRESS values (10, 1, '${HOME_LABEL.replace("'", "''")}',` +
        " '1 Infinite Loop', 'Cupertino', 'CA', '95014', 'United States');",
      "insert into ZABCDPHONENUMBER values (20, 1, 'mobile', '+15551234567');",
      "insert into ZABCDEMAILADDRESS values (30, 1, 'work', 'john@example.com');",
      "insert into ZABCDEMAILADDRESS values (31, 2, 'home', 'mia@example.com');",
    ].join(" "),
  ]);
  return store;
}

let store = "";
let storeDir = "";
beforeAll(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-ab-store-"));
  store = makeStore(storeDir);
});
afterAll(() => fs.rmSync(storeDir, { recursive: true, force: true }));

const byName = (fragment: string): string[][] =>
  query(store, CONTACTS_QUERIES.searchByName.replaceAll(CONTACTS_NAME_PLACEHOLDER, fragment));

describe("the contacts recipes the skill publishes", () => {
  it("finds a record by a name fragment, address joined on", () => {
    const rows = byName("applese");
    expect(rows.length).toBe(1);
    // record_id, first, last, nick, org, then the joined address columns.
    expect(rows[0][0]).toBe("1");
    expect(rows[0].slice(5)).toEqual([
      HOME_LABEL,
      "1 Infinite Loop",
      "Cupertino",
      "CA",
      "95014",
      "United States",
    ]);
  });

  it("finds a name with an apostrophe once the apostrophe is doubled", () => {
    const rows = byName("o''brien");
    expect(rows.length).toBe(1);
    expect(rows[0][0]).toBe("2");
    // No address: the left join keeps her, with empty address cells.
    expect(rows[0][7]).toBe("");
  });

  it("finds an organization-only record by the company name", () => {
    const rows = byName("acme");
    expect(rows.map((r) => r[0])).toEqual(["3"]);
  });

  it("assembles a contact card: phones, emails, addresses, labels verbatim", () => {
    const rows = query(
      store,
      CONTACTS_QUERIES.contactCard.replaceAll(CONTACTS_RECORD_PLACEHOLDER, "1"),
    );
    // Ordered by kind: address, email, phone.
    expect(rows.map((r) => r[0])).toEqual(["address", "email", "phone"]);
    // The CoreData label constant comes back exactly as stored — the `$!`
    // survives the read; it is shells, not sqlite, that mangle it.
    expect(rows[0][1]).toBe(HOME_LABEL);
    expect(rows[0][2]).toContain("1 Infinite Loop");
    expect(rows[1][2]).toBe("john@example.com");
    expect(rows[2][2]).toBe("+15551234567");
  });

  it("verifies an address after a save: the record's postal rows, or nothing", () => {
    const saved = query(
      store,
      CONTACTS_QUERIES.verifyAddress.replaceAll(CONTACTS_RECORD_PLACEHOLDER, "1"),
    );
    expect(saved.length).toBe(1);
    expect(saved[0]).toEqual([
      HOME_LABEL,
      "1 Infinite Loop",
      "Cupertino",
      "CA",
      "95014",
      "United States",
    ]);
    // A save that never landed shows up as an empty result, not an error.
    expect(
      query(store, CONTACTS_QUERIES.verifyAddress.replaceAll(CONTACTS_RECORD_PLACEHOLDER, "2")),
    ).toEqual([]);
  });
});
