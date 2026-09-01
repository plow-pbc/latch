/**
 * Password imports: the CSVs Apple Passwords and 1Password write, and
 * 1Password's per-item "Copy item JSON", parsed pure and then round-tripped
 * into a real LocalVault. The standing rule under test throughout: nothing a
 * parse returns — preview, warning, skip reason or error — ever carries a
 * password or a key.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalVault } from "../src/browser/localVault.js";
import { VaultKeyStore } from "../src/browser/vaultKeyStore.js";
import {
  csvRows,
  importLogins,
  importPreview,
  markAgainstVault,
  parsePasswordExport,
} from "../src/browser/passwordImport.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempVault(): { vault: LocalVault; dir: string; auditPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-import-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const auditPath = path.join(dir, "credential-audit.log");
  return { vault: new LocalVault(dir, new VaultKeyStore(dir, "test"), auditPath), auditPath };
}

const TOTP_KEY = "JBSWY3DPEHPK3PXP";

describe("csvRows", () => {
  it("reads RFC 4180: quoted commas, doubled quotes, newlines in fields, CRLF, BOM", () => {
    const text = '﻿a,b,c\r\n"1,1","say ""hi""","line\nbreak"\r\n';
    expect(csvRows(text)).toEqual([
      ["a", "b", "c"],
      ["1,1", 'say "hi"', "line\nbreak"],
    ]);
  });

  it("drops blank lines rather than minting empty rows", () => {
    expect(csvRows("a,b\n\n1,2\n\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("Apple Passwords CSV", () => {
  const apple = [
    "Title,URL,Username,Password,Notes,OTPAuth",
    `Notion,https://notion.so,jon@tumult.com,"pw,with""quote",a note,`,
    `Dropbox,https://dropbox.com,so@plow.co,drop-secret,,otpauth://totp/Dropbox:so%40plow.co?secret=${TOTP_KEY}&issuer=Dropbox`,
  ].join("\n");

  it("parses rows, names the source, and keeps quoted passwords intact", () => {
    const parsed = parsePasswordExport(apple);
    expect(parsed.source).toBe("Apple Passwords");
    expect(parsed.skipped).toEqual([]);
    expect(parsed.logins).toHaveLength(2);
    const [notion, dropbox] = parsed.logins;
    expect(notion).toMatchObject({
      title: "Notion",
      urls: ["https://notion.so"],
      username: "jon@tumult.com",
      password: 'pw,with"quote',
      notes: "a note",
      totp: "",
      warnings: [],
    });
    expect(dropbox!.totp).toContain(TOTP_KEY);
  });

  it("sets aside a row with no website — the vault could never fill it — and says why", () => {
    const parsed = parsePasswordExport(
      "Title,URL,Username,Password,Notes,OTPAuth\nWi-Fi,,'',hunter2,,",
    );
    expect(parsed.logins).toEqual([]);
    expect(parsed.skipped).toHaveLength(1);
    expect(parsed.skipped[0]!.reason).toMatch(/no website address/);
    expect(parsed.skipped[0]!.reason).not.toContain("hunter2");
  });

  it("warns about a missing password and completes a bare host, but still imports", () => {
    const parsed = parsePasswordExport(
      "Title,URL,Username,Password,Notes,OTPAuth\nOld site,example.com,jon,,,",
    );
    expect(parsed.logins).toHaveLength(1);
    expect(parsed.logins[0]!.urls).toEqual(["https://example.com"]);
    expect(parsed.logins[0]!.warnings.join(" ")).toMatch(/no password/);
  });

  it("drops an unreadable authenticator key with a warning that never echoes it", () => {
    const parsed = parsePasswordExport(
      "Title,URL,Username,Password,Notes,OTPAuth\nX,https://x.example,jon,pw,,123456",
    );
    expect(parsed.logins[0]!.totp).toBe("");
    const said = parsed.logins[0]!.warnings.join(" ");
    expect(said).toMatch(/one-time password key/);
    expect(said).not.toContain("123456");
  });

  it("names a row with no title after its site", () => {
    const parsed = parsePasswordExport(
      "Title,URL,Username,Password,Notes,OTPAuth\n,https://pizza.example/login,jon,pw,,",
    );
    expect(parsed.logins[0]!.title).toBe("pizza.example");
  });
});

describe("1Password CSV", () => {
  const onePw = [
    "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes",
    `GitHub,https://github.com,jon,gh-secret,${TOTP_KEY},true,false,work,ssh note`,
    "Dead account,https://dead.example,jon,old-secret,,false,true,,",
  ].join("\n");

  it("parses its column order, skips archived rows, and drops tags/favorite silently", () => {
    const parsed = parsePasswordExport(onePw);
    expect(parsed.source).toBe("1Password");
    expect(parsed.logins).toHaveLength(1);
    expect(parsed.logins[0]).toMatchObject({
      title: "GitHub", username: "jon", password: "gh-secret", totp: TOTP_KEY, notes: "ssh note",
    });
    expect(parsed.skipped).toEqual([{ title: "Dead account", reason: "archived in 1Password" }]);
  });
});

describe("Chrome CSV", () => {
  it("parses Google Password Manager's export: name is the title, note the notes", () => {
    const parsed = parsePasswordExport(
      "name,url,username,password,note\ngoogle.com,https://accounts.google.com,jon,g-secret,work account",
    );
    expect(parsed.source).toBe("Chrome");
    expect(parsed.logins).toHaveLength(1);
    expect(parsed.logins[0]).toMatchObject({
      title: "google.com",
      urls: ["https://accounts.google.com"],
      username: "jon",
      password: "g-secret",
      notes: "work account",
      totp: "",
      warnings: [],
    });
  });
});

describe("CSV headers", () => {
  it("takes any column order that still names title/url/username/password", () => {
    const parsed = parsePasswordExport("Password,Username,Title,URL\npw,jon,Site,https://s.example");
    expect(parsed.source).toBe("CSV");
    expect(parsed.logins[0]).toMatchObject({ title: "Site", username: "jon", password: "pw" });
  });

  it("refuses a CSV that is not a passwords export, naming what was expected", () => {
    expect(() => parsePasswordExport("name,email\njon,jon@tumult.com")).toThrow(
      /Title, URL, Username and Password/,
    );
  });
});

/** The shape "Copy item JSON" produces, per the real Dropbox sample. */
function onePwItemJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    overview: {
      title: "Dropbox",
      ainfo: "so@plow.co",
      url: "https://www.dropbox.com",
      URLs: [{ u: "https://www.dropbox.com", l: "website", m: "default" }],
      ps: 90,
    },
    details: {
      fields: [
        { value: "drop-secret", id: "", name: "password", type: "P", designation: "password" },
        { value: "so@plow.co", id: "", name: "username", type: "T", designation: "username" },
      ],
      sections: [
        {
          name: "add more",
          title: "",
          fields: [
            {
              t: "one-time password",
              n: "TOTP_varaero3oygcxrfk5bdco4kqjm",
              k: "concealed",
              v: TOTP_KEY,
              inputTraits: { autocorrection: "no", autocapitalization: "none" },
            },
          ],
        },
      ],
    },
    createdAt: "2026-05-12T22:56:57Z",
    updatedAt: "2026-05-15T16:48:25Z",
    trashed: "N",
    templateUuid: "001",
    uuid: "rit7w7cpja6k6uzbupcokein3a",
    ...overrides,
  });
}

describe("1Password item JSON", () => {
  it("reads title, credentials, sites and the TOTP section field", () => {
    const parsed = parsePasswordExport(onePwItemJson());
    expect(parsed.source).toBe("1Password item");
    expect(parsed.logins).toHaveLength(1);
    expect(parsed.logins[0]).toMatchObject({
      title: "Dropbox",
      urls: ["https://www.dropbox.com"],
      username: "so@plow.co",
      password: "drop-secret",
      totp: TOTP_KEY,
      warnings: [],
    });
  });

  it("refuses an item of another template — a card must not become a login", () => {
    expect(() => parsePasswordExport(onePwItemJson({ templateUuid: "002" }))).toThrow(/different type/);
  });

  it("warns, but still imports, an item whose password field is empty", () => {
    const item = JSON.parse(onePwItemJson()) as {
      details: { fields: Array<{ designation: string; value: string }> };
    };
    item.details.fields = item.details.fields.filter((f) => f.designation !== "password");
    const parsed = parsePasswordExport(JSON.stringify(item));
    expect(parsed.logins).toHaveLength(1);
    expect(parsed.logins[0]!.warnings.join(" ")).toMatch(/no password/);
  });

  it("refuses an item with neither username nor password fields", () => {
    const item = JSON.parse(onePwItemJson()) as { details: { fields: unknown[] } };
    item.details.fields = [];
    expect(() => parsePasswordExport(JSON.stringify(item))).toThrow(/does not look like a login/);
  });

  it("refuses text that is not JSON at all, pointing at Copy item JSON", () => {
    expect(() => parsePasswordExport("{not json")).toThrow(/Copy item JSON/);
  });

  it("sets aside an item with no site rather than saving an unfillable login", () => {
    const item = JSON.parse(onePwItemJson()) as { overview: Record<string, unknown> };
    delete item.overview.url;
    item.overview.URLs = [];
    const parsed = parsePasswordExport(JSON.stringify(item));
    expect(parsed.logins).toEqual([]);
    expect(parsed.skipped[0]!.reason).toMatch(/no website address/);
  });
});

describe("importPreview", () => {
  it("never carries a password or a key — only whether one is there", () => {
    const parsed = parsePasswordExport(onePwItemJson());
    const preview = importPreview(parsed);
    const shown = JSON.stringify(preview);
    expect(shown).not.toContain("drop-secret");
    expect(shown).not.toContain(TOTP_KEY);
    expect(preview.items[0]).toMatchObject({ hasPassword: true, hasTotp: true, duplicate: false });
  });
});

describe("into the vault", () => {
  const apple = [
    "Title,URL,Username,Password,Notes,OTPAuth",
    `Dropbox,https://dropbox.com,so@plow.co,drop-secret,,otpauth://totp/D?secret=${TOTP_KEY}`,
    "Notion,https://notion.so,jon,notion-secret,team space,",
  ].join("\n");

  /** A vault already holding this export — what every re-import case opens on. */
  async function seededAppleVault() {
    const seeded = tempVault();
    const parsed = parsePasswordExport(apple);
    await markAgainstVault(seeded.vault, parsed.logins);
    await importLogins(seeded.vault, parsed.logins);
    return seeded;
  }

  /** Parse, classify against the vault, and import — the whole inspect+commit. */
  async function runImport(vault: import("../src/browser/localVault.js").LocalVault, text: string) {
    const parsed = parsePasswordExport(text);
    await markAgainstVault(vault, parsed.logins);
    return { parsed, result: await importLogins(vault, parsed.logins) };
  }

  it("imports through the vault's own save: items land, secrets seal, audit says CREATED", async () => {
    const { vault, auditPath } = tempVault();
    const parsed = parsePasswordExport(apple);
    await markAgainstVault(vault, parsed.logins);
    const result = await importLogins(vault, parsed.logins);
    expect(result).toEqual({ saved: 2, updated: 0, duplicates: 0, failed: [] });

    const items = await vault.list();
    expect(items.map((i) => i.title).sort()).toEqual(["Dropbox", "Notion"]);
    const dropbox = items.find((i) => i.title === "Dropbox")!;
    expect(await vault.reveal(dropbox.id, "password")).toBe("drop-secret");
    expect((await vault.totp(dropbox.id)).code).toMatch(/^\d{6}$/);

    const audit = fs.readFileSync(auditPath, "utf8");
    expect(audit).toMatch(/CREATED/);
    expect(audit).not.toContain("drop-secret");
    expect(audit).not.toContain("notion-secret");
  });

  it("running the same export twice doubles nothing: the second pass is all duplicates", async () => {
    const { vault } = await seededAppleVault();
    const { parsed, result } = await runImport(vault, apple);
    expect(parsed.logins.every((l) => l.duplicate)).toBe(true);
    expect(result).toEqual({ saved: 0, updated: 0, duplicates: 2, failed: [] });
    expect(await vault.list()).toHaveLength(2);
  });

  it("a changed password becomes an update of the existing item, not a double", async () => {
    const { vault, auditPath } = await seededAppleVault();

    const again = parsePasswordExport(apple.replace("notion-secret", "notion-rotated"));
    await markAgainstVault(vault, again.logins);
    const notion = again.logins.find((l) => l.title === "Notion")!;
    expect(notion.duplicate).toBeUndefined();
    expect(notion.update?.fields).toEqual(["password"]);
    expect(again.logins.find((l) => l.title === "Dropbox")!.duplicate).toBe(true);

    const result = await importLogins(vault, again.logins);
    expect(result).toEqual({ saved: 0, updated: 1, duplicates: 1, failed: [] });
    const items = await vault.list();
    expect(items).toHaveLength(2); // updated in place, never doubled
    const stored = items.find((i) => i.title === "Notion")!;
    expect(stored.subtitle).toBe("jon"); // untouched fields stay as they were
    expect(await vault.reveal(stored.id, "password")).toBe("notion-rotated");
    const audit = fs.readFileSync(auditPath, "utf8");
    expect(audit).toMatch(/UPDATED/);
    expect(audit).not.toContain("notion-rotated");
  });

  it("a changed key updates only the key; the same key respelled is no change at all", async () => {
    const { vault } = await seededAppleVault();

    // The same secret as a bare key instead of an otpauth URI: one key, two
    // spellings — flagging it changed would rewrite items on every re-import.
    const respelled = parsePasswordExport(apple.replace(`otpauth://totp/D?secret=${TOTP_KEY}`, TOTP_KEY));
    await markAgainstVault(vault, respelled.logins);
    expect(respelled.logins.find((l) => l.title === "Dropbox")!.duplicate).toBe(true);

    // A genuinely different key is an update, and only of the key.
    const rotated = parsePasswordExport(apple.replace(`secret=${TOTP_KEY}`, "secret=KRSXG5CTMVRXEZLU"));
    await markAgainstVault(vault, rotated.logins);
    const dropbox = rotated.logins.find((l) => l.title === "Dropbox")!;
    expect(dropbox.update?.fields).toEqual(["totp"]);
    const result = await importLogins(vault, rotated.logins);
    expect(result.updated).toBe(1);
    const stored = (await vault.list()).find((i) => i.title === "Dropbox")!;
    expect(await vault.reveal(stored.id, "password")).toBe("drop-secret"); // untouched
    expect(await vault.reveal(stored.id, "totp")).toContain("KRSXG5CTMVRXEZLU");
  });

  it("an export that carries no key does not read as removing the stored one", async () => {
    const { vault } = await seededAppleVault();

    // The same login out of a manager whose CSV has no OTPAuth column.
    const bare = parsePasswordExport(
      "name,url,username,password,note\nDropbox,https://dropbox.com,so@plow.co,drop-secret,",
    );
    await markAgainstVault(vault, bare.logins);
    expect(bare.logins[0]!.duplicate).toBe(true);
    await importLogins(vault, bare.logins);
    const stored = (await vault.list()).find((i) => i.title === "Dropbox")!;
    expect((await vault.totp(stored.id)).code).toMatch(/^\d{6}$/); // key still there
  });

  it("refuses an update composed against an item the vault rewrote in between", async () => {
    const { vault } = await seededAppleVault();

    const again = parsePasswordExport(apple.replace("notion-secret", "notion-rotated"));
    await markAgainstVault(vault, again.logins); // revision pinned here
    const notion = (await vault.list()).find((i) => i.title === "Notion")!;
    await vault.save({ itemId: notion.id, revision: (await vault.read(notion.id)).revision, password: "typed-by-hand" });

    const result = await importLogins(vault, again.logins);
    expect(result.updated).toBe(0);
    expect(result.failed[0]!.reason).toMatch(/changed somewhere else/);
    expect(await vault.reveal(notion.id, "password")).toBe("typed-by-hand"); // the hand edit stands
  });

  // Two entries sharing a name, username and site are legal in every source
  // app, so one identity can mean SEVERAL vault items and several export rows.
  const twins = [
    "Title,URL,Username,Password,Notes,OTPAuth",
    "Mail,https://mail.example,jon,first-secret,,",
    "Mail,https://mail.example,jon,second-secret,,",
  ].join("\n");

  it("re-importing twin rows unchanged updates nothing — each finds its identical item", async () => {
    const { vault } = tempVault();
    await runImport(vault, twins); // both new: two items, one identity
    const { result } = await runImport(vault, twins);
    expect(result).toEqual({ saved: 0, updated: 0, duplicates: 2, failed: [] });
    // Neither password was cross-written by the other row.
    const passwords = await Promise.all(
      (await vault.list()).map((i) => vault.reveal(i.id, "password")),
    );
    expect(passwords.sort()).toEqual(["first-secret", "second-secret"]);
  });

  it("leaves a row alone, and says so, when several differing items could be its target", async () => {
    const { vault } = tempVault();
    await runImport(vault, twins);
    const { parsed, result } = await runImport(
      vault,
      "Title,URL,Username,Password,Notes,OTPAuth\nMail,https://mail.example,jon,third-secret,,",
    );
    expect(result).toEqual({ saved: 0, updated: 0, duplicates: 1, failed: [] });
    expect(parsed.logins[0]!.warnings.join(" ")).toMatch(/more than one item/);
    const passwords = await Promise.all(
      (await vault.list()).map((i) => vault.reveal(i.id, "password")),
    );
    expect(passwords.sort()).toEqual(["first-secret", "second-secret"]); // untouched
  });

  it("lets only one row of an export claim an item; the second is left alone, not raced", async () => {
    const { vault } = tempVault();
    await runImport(
      vault,
      "Title,URL,Username,Password,Notes,OTPAuth\nMail,https://mail.example,jon,old-secret,,",
    );
    const { parsed, result } = await runImport(vault, twins); // both rows differ from the one item
    expect(result).toEqual({ saved: 0, updated: 1, duplicates: 1, failed: [] });
    expect(parsed.logins[1]!.warnings.join(" ")).toMatch(/another row in this import/);
    const item = (await vault.list())[0]!;
    expect(await vault.reveal(item.id, "password")).toBe("first-secret");
  });

  it("collects a bad row's failure instead of sinking the rest", async () => {
    const { vault } = tempVault();
    const parsed = parsePasswordExport(apple);
    // Sabotage one row past the parser's own checks, the way a race or an
    // unforeseen vault rule would: blank the name save requires.
    parsed.logins[0]!.title = "";
    const result = await importLogins(vault, parsed.logins);
    expect(result.saved).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.reason).toMatch(/name/);
  });
});
