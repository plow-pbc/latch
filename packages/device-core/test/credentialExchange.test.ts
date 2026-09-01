/**
 * The credential-exchange wire JSON (what the desktop app's Swift shim emits
 * from ASExportedCredentialData) read into the import pipeline's shapes. The
 * wire schema is OURS — these tests are what freeze it: a Swift-side change
 * that breaks them is a change to a cross-language contract, not a refactor.
 */
import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  parseCredentialExchange,
  totpParams,
  type ExchangeItem,
} from "../src/index.js";

const payload = (items: Partial<ExchangeItem>[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, exporter: "Passwords", items, ...extra });

const login = (over: Partial<ExchangeItem> = {}): Partial<ExchangeItem> => ({
  title: "GitHub",
  urls: ["https://github.com"],
  username: "octocat",
  password: "hunter2",
  unsupported: [],
  ...over,
});

describe("base32Encode", () => {
  it("round-trips through the vault's own decoder", () => {
    for (const text of ["f", "fo", "foo", "foob", "fooba", "foobar", "\x00\xff\x10"]) {
      const buf = Buffer.from(text, "latin1");
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
  });

  it("matches the RFC 4648 vectors, without padding", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Encode(Buffer.from("fo"))).toBe("MZXQ");
    expect(base32Encode(Buffer.alloc(0))).toBe("");
  });
});

describe("parseCredentialExchange", () => {
  it("reads a login: title, sites, username, password, notes", () => {
    const parsed = parseCredentialExchange(payload([login({ notes: "the recovery codes are in the safe" })]));
    expect(parsed.source).toBe("Passwords");
    expect(parsed.skipped).toEqual([]);
    expect(parsed.logins).toHaveLength(1);
    const l = parsed.logins[0]!;
    expect(l.title).toBe("GitHub");
    expect(l.urls).toEqual(["https://github.com"]);
    expect(l.username).toBe("octocat");
    expect(l.password).toBe("hunter2");
    expect(l.notes).toBe("the recovery codes are in the safe");
    expect(l.warnings).toEqual([]);
  });

  it("refuses a wire version it does not understand, and unreadable JSON", () => {
    expect(() => parseCredentialExchange(JSON.stringify({ version: 2, exporter: "x", items: [] })))
      .toThrow(/shape this build does not understand/);
    expect(() => parseCredentialExchange("not json")).toThrow(/could not be read/);
  });

  it("names the exporter, with a face for an app that gave none", () => {
    const anon = JSON.stringify({ version: 1, exporter: "", items: [] });
    expect(parseCredentialExchange(anon).source).toBe("another app");
  });

  it("keeps every readable site and warns about an unreadable one", () => {
    const parsed = parseCredentialExchange(
      payload([login({ urls: ["https://a.example", "///", "b.example"] })]),
    );
    const l = parsed.logins[0]!;
    expect(l.urls).toEqual(["https://a.example", "https://b.example"]);
    expect(l.warnings.some((w) => w.includes("could not be read"))).toBe(true);
  });

  it("skips an item with no site, the same way the CSV path does", () => {
    const parsed = parseCredentialExchange(payload([login({ urls: [] })]));
    expect(parsed.logins).toEqual([]);
    expect(parsed.skipped[0]!.reason).toContain("has no website address");
  });

  it("skips an item whose only site is unreadable", () => {
    const parsed = parseCredentialExchange(payload([login({ urls: ["///"] })]));
    expect(parsed.logins).toEqual([]);
    expect(parsed.skipped[0]!.reason).toBe("its website address could not be read");
  });

  it("skips a non-login item by saying what it is", () => {
    const parsed = parseCredentialExchange(
      payload([{ title: "Visa", urls: [], unsupported: ["creditCard"] }]),
    );
    expect(parsed.logins).toEqual([]);
    expect(parsed.skipped[0]!).toEqual({ title: "Visa", reason: "is a credit card, not a login" });
  });

  it("keeps a login and says what rode along that could not come", () => {
    const parsed = parseCredentialExchange(
      payload([login({ unsupported: ["passkey", "customFields"] })]),
    );
    const l = parsed.logins[0]!;
    expect(l.warnings).toEqual(["also carries a passkey and custom fields, which was not imported"]);
  });

  it("stores a default-parameter key as bare base32 the vault can read", () => {
    const secret = Buffer.from("12345678901234567890", "latin1");
    const parsed = parseCredentialExchange(
      payload([
        login({
          totp: { secretBase64: secret.toString("base64"), period: 30, digits: 6, algorithm: "sha1" },
        }),
      ]),
    );
    const key = parsed.logins[0]!.totp;
    expect(key).toBe(base32Encode(secret));
    expect(totpParams(key).secret.equals(secret)).toBe(true);
  });

  it("stores off-default parameters as an otpauth URI that carries them", () => {
    const secret = Buffer.from("12345678901234567890123456789012", "latin1");
    const parsed = parseCredentialExchange(
      payload([
        login({
          totp: {
            secretBase64: secret.toString("base64"),
            period: 60,
            digits: 8,
            algorithm: "sha256",
            issuer: "Example Corp",
            userName: "octocat",
          },
        }),
      ]),
    );
    const key = parsed.logins[0]!.totp;
    expect(key.startsWith("otpauth://totp/")).toBe(true);
    const params = totpParams(key);
    expect(params.secret.equals(secret)).toBe(true);
    expect(params.period).toBe(60);
    expect(params.digits).toBe(8);
    expect(params.algorithm).toBe("sha256");
    expect(key).toContain("issuer=Example+Corp");
  });

  it("drops an unreadable key with a warning instead of sinking the row", () => {
    const parsed = parseCredentialExchange(
      payload([login({ totp: { secretBase64: "", period: 30, digits: 6, algorithm: "sha1" } })]),
    );
    const l = parsed.logins[0]!;
    expect(l.totp).toBe("");
    expect(l.warnings).toEqual(["its one-time password key could not be read and was not imported"]);
  });

  it("warns about a login the export holds no password for", () => {
    const parsed = parseCredentialExchange(payload([login({ password: "" })]));
    expect(parsed.logins[0]!.warnings).toEqual(["the export holds no password for it"]);
  });

  it("names an untitled login after its site", () => {
    const parsed = parseCredentialExchange(payload([login({ title: "" })]));
    expect(parsed.logins[0]!.title).toBe("github.com");
  });

  it("refuses an implausibly large hand-off outright", () => {
    expect(() => parseCredentialExchange("x".repeat(21 * 1024 * 1024))).toThrow(/too large/);
  });
});
