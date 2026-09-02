/**
 * 1PUX: 1Password's unencrypted export, a zip whose export.data nests items
 * inside their vaults. The parser reads only that entry, keeps logins, and
 * names every row's vault so the sheet can offer a pick. Same standing rule
 * as the CSV paths: nothing returned ever carries a password or a key.
 */
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseOnePux } from "../src/browser/onePux.js";
import { importPreview } from "../src/browser/passwordImport.js";

const TOTP_KEY = "JBSWY3DPEHPK3PXP";

/** A minimal zip writer: local headers, central directory, end record.
 * CRCs are written as zero — the reader does not check them, and 1PUX
 * readers in the wild don't either. */
function zipOf(entries: Record<string, string | Uint8Array>, opts: { deflate: boolean }): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    // A Uint8Array entry is bytes already compressed by the caller (for
    // building an oversized deflate stream); it is stored under method 8
    // as-is, ignoring `opts.deflate`.
    const precompressed = value instanceof Uint8Array;
    const raw = precompressed ? Buffer.from(value) : Buffer.from(value, "utf8");
    const data = precompressed ? raw : opts.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = precompressed || opts.deflate ? 8 : 0;
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    parts.push(local, nameBuf, data);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cdBuf, end]));
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

  it("sets aside archived items, non-logins and site-less logins, each under its vault", () => {
    const parsed = parseOnePux(onePux([{ name: "Personal", items: [
      login("Old", { state: "archived" }),
      { uuid: "c", categoryUuid: "002", state: "active", overview: { title: "Visa" }, details: {} },
      { uuid: "k", categoryUuid: "114", state: "active", overview: { title: "deploy key" }, details: {} },
      login("Router", { overview: { title: "Router" } }),
      login("Live"),
    ] }]));
    expect(parsed.logins.map((l) => l.title)).toEqual(["Live"]);
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

    // A truncated compressed export.data — the zip container (and its end
    // record) stays intact; only this entry's deflate stream is corrupted, so
    // this exercises inflateRawSync's own failure path rather than the
    // "no end record" check that a truncated whole zip would hit instead.
    const compressed = zlib.deflateRawSync(Buffer.from(exportData([{ name: "P", items: [login("X")] }]), "utf8"));
    const truncated = compressed.subarray(0, Math.floor(compressed.length / 2));
    expect(() => parseOnePux(zipOf({ "export.data": truncated }, { deflate: false }))).toThrow(/1PUX/);

    // Highly repetitive, so it compresses to a tiny blob but still decodes
    // past the 64 MiB cap — the shape a hostile or corrupted zip bomb takes.
    const huge = zlib.deflateRawSync(Buffer.alloc(100 * 1024 * 1024, "a"));
    expect(() => parseOnePux(zipOf({ "export.data": huge }, { deflate: false }))).toThrow(/1PUX/);
  });

  it("previews with the vault name and never a secret", () => {
    const parsed = parseOnePux(onePux([{ name: "Personal", items: [login("Dropbox")] }]));
    const text = JSON.stringify(importPreview(parsed));
    expect(text).not.toContain("Dropbox-secret");
    expect(importPreview(parsed).items[0]).toMatchObject({ title: "Dropbox", vault: "Personal", hasPassword: true, hasTotp: false });
  });
});
