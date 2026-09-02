import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { parseOnePux } from "../src/browser/onePux.js";
import { importPreview, importVaults, parsePasswordExport } from "../src/browser/passwordImport.js";

const TOTP_KEY = "JBSWY3DPEHPK3PXP";

/** A zip written with the same library the parser reads, so these fixtures
 * carry real CRCs. `deflate: false` stores the entries instead — a 1PUX in
 * the wild can be either. */
function zipOf(entries: Record<string, string | Uint8Array>, opts: { deflate: boolean }): Uint8Array {
  const zip = new AdmZip();
  for (const [name, value] of Object.entries(entries)) {
    const entry = zip.addFile(name, Buffer.from(value as Uint8Array | string));
    if (!opts.deflate) entry.header.method = 0;
  }
  return new Uint8Array(zip.toBuffer());
}

/** The same zip with its FIRST entry's payload bytes flipped: the container
 * and its central directory still parse, so this reaches the reader's own CRC
 * check rather than failing as a malformed archive. */
function corrupt(zip: Uint8Array): Uint8Array {
  const buf = Buffer.from(zip);
  buf[30 + buf.readUInt16LE(26) + buf.readUInt16LE(28) + 4] ^= 0xff;
  return new Uint8Array(buf);
}

const login = (title: string, extra: Record<string, unknown> = {}) => ({
  uuid: title.toLowerCase(),
  categoryUuid: "001",
  state: "active",
  overview: { title, url: `https://${title.toLowerCase()}.com`, urls: [{ label: "website", url: `https://${title.toLowerCase()}.com` }] },
  details: {
    loginFields: [
      { designation: "username", value: `${title.toLowerCase()}-user` },
      { designation: "password", value: `${title}-secret` },
    ],
    notesPlain: "",
    sections: [],
  },
  ...extra,
});

const exportData = (vaults: Array<{ name: string; type?: string; items: unknown[] }>) =>
  JSON.stringify({
    accounts: [{ attrs: { name: "Sam" }, vaults: vaults.map((v) => ({ attrs: { uuid: v.name, name: v.name, type: v.type ?? "P" }, items: v.items })) }],
  });

const onePux = (vaults: Array<{ name: string; type?: string; items: unknown[] }>, deflate = true) =>
  zipOf(
    { "export.attributes": '{"version":3,"description":"1Password Unencrypted Export"}', "export.data": exportData(vaults), "files/": "" },
    { deflate },
  );

describe("parseOnePux", () => {
  it("reads logins out of every vault, naming the vault on each row", () => {
    const parsed = parseOnePux(onePux([
      { name: "Personal", items: [login("Dropbox", {
        details: {
          loginFields: [{ designation: "username", value: "so@plow.co" }, { designation: "password", value: "drop-secret" }],
          notesPlain: "work files",
          sections: [{ title: "", name: "s1", fields: [{ title: "one-time password", id: "TOTP_1", value: { totp: `otpauth://totp/D?secret=${TOTP_KEY}` } }] }],
        },
      })] },
      { name: "Family", type: "U", items: [login("Netflix")] },
    ]));
    expect(parsed.source).toBe("1Password");
    expect(parsed.skipped).toEqual([]);
    expect(parsed.logins.map((l) => [l.title, l.vault])).toEqual([["Dropbox", "Personal"], ["Netflix", "Family"]]);
    const dropbox = parsed.logins[0]!;
    expect(dropbox).toMatchObject({ username: "so@plow.co", password: "drop-secret", notes: "work files", urls: ["https://dropbox.com"], warnings: [] });
    expect(dropbox.totp).toContain(TOTP_KEY);
  });

  it("reads a stored (uncompressed) zip too, and a TOTP kept as a concealed otpauth field", () => {
    const parsed = parseOnePux(onePux([{ name: "Personal", items: [login("GitHub", {
      details: {
        loginFields: [{ designation: "username", value: "sam" }, { designation: "password", value: "gh-secret" }],
        sections: [{ name: "s", fields: [{ title: "2FA", id: "TOTP_abc", value: { concealed: `otpauth://totp/G?secret=${TOTP_KEY}` } }] }],
      },
    })] }], false));
    expect(parsed.logins[0]!.totp).toContain(TOTP_KEY);
  });

  it("sets aside archived items, non-logins and site-less logins, each under its vault — but keeps a login when only one of its URLs is unreadable", () => {
    const parsed = parseOnePux(onePux([{ name: "Personal", items: [
      login("Old", { state: "archived" }),
      { uuid: "c", categoryUuid: "002", state: "active", overview: { title: "Visa" }, details: {} },
      { uuid: "k", categoryUuid: "114", state: "active", overview: { title: "deploy key" }, details: {} },
      login("Router", { overview: { title: "Router" } }),
      login("Mixed", { overview: { title: "Mixed", urls: [{ label: "good", url: "https://good.example.com" }, { label: "junk", url: "not a url" }] } }),
      login("Live"),
    ] }]));
    expect(parsed.logins.map((l) => l.title)).toEqual(["Mixed", "Live"]);
    expect(parsed.logins[0]!.urls).toEqual(["https://good.example.com"]);
    expect(parsed.logins[0]!.warnings).toContain("one of its website addresses could not be read and was left off");
    expect(parsed.skipped).toEqual([
      { title: "Old", reason: "archived in 1Password", vault: "Personal" },
      { title: "Visa", reason: "a credit card, not a login", vault: "Personal" },
      { title: "deploy key", reason: "an SSH key, not a login", vault: "Personal" },
      { title: "Router", reason: "has no website address; add it by hand as a new item if you still use it", vault: "Personal" },
    ]);
  });

  it("warns, but keeps, a login with no password, and drops an unreadable key without echoing it", () => {
    const parsed = parseOnePux(onePux([{ name: "P", items: [login("Bare", {
      details: {
        loginFields: [{ designation: "username", value: "u" }],
        sections: [{ name: "s", fields: [{ title: "one-time password", id: "TOTP_x", value: { totp: "not-a-key-1zzz" } }] }],
      },
    })] }]));
    const bare = parsed.logins[0]!;
    expect(bare.password).toBe("");
    expect(bare.totp).toBe("");
    expect(bare.warnings.join(" ")).not.toContain("zzz");
    expect(bare.warnings).toHaveLength(2);
  });

  it("refuses what is not a 1PUX export, naming what was expected", () => {
    expect(() => parseOnePux(zipOf({ "readme.txt": "hi" }, { deflate: true }))).toThrow(/1PUX/);
    expect(() => parseOnePux(new Uint8Array(Buffer.from("Title,URL\n")))).toThrow(/1PUX/);
    expect(() => parseOnePux(zipOf({ "export.data": "{\"nope\":1}" }, { deflate: false }))).toThrow(/1PUX/);

    // export.data's payload flipped under an intact container: the CRC the
    // archive declares no longer matches, which is the reader's own refusal
    // rather than a malformed-zip one.
    const good = zipOf({ "export.data": exportData([{ name: "P", items: [login("X")] }]) }, { deflate: true });
    expect(parseOnePux(good).logins).toHaveLength(1);
    expect(() => parseOnePux(corrupt(good))).toThrow(/1PUX/);
  });

  it("refuses an export.data the declared size does not bound, before inflating any of it", () => {
    // Past the 64 MiB cap — the shape a hostile or corrupted zip bomb takes.
    // The declared size is what is refused, so a lying header cannot spend
    // the memory the cap exists to protect either.
    const huge = zipOf({ "export.data": new Uint8Array(65 * 1024 * 1024) }, { deflate: true });
    expect(() => parseOnePux(huge)).toThrow(/too large/);

    // The same hole from the other side: adm-zip bounds the inflate only
    // while the declared size is positive, so a deflated entry claiming ZERO
    // would inflate unbounded. Patched into the archive the way a hostile
    // export would carry it — the data is real, the size it declares is not.
    const zip = new AdmZip();
    zip.addFile("export.data", Buffer.from(exportData([{ name: "P", items: [login("X")] }])));
    zip.getEntry("export.data")!.header.size = 0;
    expect(() => parseOnePux(new Uint8Array(zip.toBuffer()))).toThrow(/1PUX/);
  });

  it("names the vaults a parsed export spans, skipped-only ones included", () => {
    const parsed = parseOnePux(onePux([
      { name: "Personal", items: [login("Dropbox")] },
      { name: "Shared", items: [login("Old", { state: "archived" })] },
    ]));
    expect(importVaults(parsed)).toEqual(["Personal", "Shared"]);
    // A source that knows no vaults names none, so no pick step is offered.
    expect(importVaults(parsePasswordExport("Title,URL,Username,Password\nA,https://a.example,u,p\n"))).toEqual([]);
  });

  it("previews with the vault name and never a secret", () => {
    const parsed = parseOnePux(onePux([{ name: "Personal", items: [login("Dropbox")] }]));
    const text = JSON.stringify(importPreview(parsed));
    expect(text).not.toContain("Dropbox-secret");
    expect(importPreview(parsed).items[0]).toMatchObject({ title: "Dropbox", vault: "Personal", hasPassword: true, hasTotp: false });
  });
});
