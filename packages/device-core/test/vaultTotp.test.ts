/**
 * The six digits, and what an owner is allowed to paste to get them.
 *
 * The generator is checked against RFC 6238's own vectors — the point of a
 * standard code is that it matches what the site expects, and nothing else
 * here can prove that. The rest is the paste: the shapes a real site hands
 * someone, and the shapes that must be refused rather than stored as a key
 * that will never produce a working code.
 */
import { describe, expect, it } from "vitest";
import { base32Decode, totpCode, totpParams } from "@domo/device-core";

/** RFC 6238 Appendix B: the seed is ASCII "1234567890" repeated. */
const SHA1 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SHA256 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA====";
const SHA512 =
  "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA=";

const at = (key: string, seconds: number, extra = "") =>
  totpCode(`otpauth://totp/x?secret=${key}&digits=8${extra}`, seconds * 1000).code;

describe("the codes RFC 6238 says a key produces", () => {
  it.each([
    [59, "94287082"],
    [1_111_111_109, "07081804"],
    [1_111_111_111, "14050471"],
    [1_234_567_890, "89005924"],
    [2_000_000_000, "69279037"],
    [20_000_000_000, "65353130"],
  ])("SHA-1 at %i", (seconds, expected) => {
    expect(at(SHA1, seconds)).toBe(expected);
  });

  it("SHA-256 and SHA-512, which an otpauth link may ask for", () => {
    expect(at(SHA256, 59, "&algorithm=SHA256")).toBe("46119246");
    expect(at(SHA512, 59, "&algorithm=SHA512")).toBe("90693936");
  });

  // The default nobody writes down: six digits, thirty seconds, SHA-1.
  it("defaults to what every authenticator app assumes", () => {
    const p = totpParams(SHA1);
    expect({ digits: p.digits, period: p.period, algorithm: p.algorithm })
      .toEqual({ digits: 6, period: 30, algorithm: "sha1" });
    expect(totpCode(SHA1, 59_000).code).toBe("287082"); // the SHA-1 vector, truncated
  });
});

describe("what an owner is allowed to paste", () => {
  // A site prints its key in lowercase four-character groups. Refusing that
  // would refuse the way the key is actually handed to people.
  it("takes the key the way sites print it", () => {
    const spaced = "gezd gnbv gy3t qojq gezd gnbv gy3t qojq";
    expect(totpCode(spaced, 59_000).code).toBe(totpCode(SHA1, 59_000).code);
    expect(base32Decode("gezd-gnbv").equals(base32Decode("GEZDGNBV"))).toBe(true);
    expect(base32Decode("GEZA====").equals(base32Decode("GEZA"))).toBe(true);
  });

  it("takes the whole otpauth link the QR code carries", () => {
    const uri = `otpauth://totp/Google:daniel%40plow.co?secret=${SHA1}&issuer=Google`;
    expect(totpCode(uri, 59_000).code).toBe(totpCode(SHA1, 59_000).code);
  });

  it("reads the parameters a link overrides, rather than assuming", () => {
    const p = totpParams(`otpauth://totp/x?secret=${SHA1}&digits=8&period=60&algorithm=SHA512`);
    expect({ digits: p.digits, period: p.period, algorithm: p.algorithm })
      .toEqual({ digits: 8, period: 60, algorithm: "sha512" });
  });

  /*
   * The whole point of the refusals: a key that cannot make a code must be
   * refused WHEN IT IS PASTED. Stored, it is indistinguishable from a good one
   * until a site rejects the number — which is exactly the dead end the owner
   * hit, with nothing on screen to say the paste was the wrong thing.
   */
  it.each([
    ["the six-digit code instead of the key", "123456"],
    ["an empty box", "   "],
    ["a password that is not base32", "hunter2!"],
    ["a counter-based link, whose codes are not clock-derived", `otpauth://hotp/x?secret=${SHA1}&counter=1`],
    ["a link with no secret in it", "otpauth://totp/x?issuer=Google"],
    ["a hash this app cannot compute", `otpauth://totp/x?secret=${SHA1}&algorithm=SHA3`],
    ["a digit count no site asks for", `otpauth://totp/x?secret=${SHA1}&digits=99`],
  ])("refuses %s", (_what, pasted) => {
    expect(() => totpCode(pasted, 59_000)).toThrow();
  });

  it("names the mistake everybody makes, rather than talking about base32", () => {
    // The six digits ARE what "TOTP" means to most people, so this paste is
    // the common one and it gets a sentence that says what to do instead.
    expect(() => totpCode("123456")).toThrow(/that is a code, not a key/);
    expect(() => totpCode("012 345")).toThrow(/that is a code, not a key/);
  });
});

describe("how long a code has left", () => {
  it("counts down inside the step and never reads zero", () => {
    expect(totpCode(SHA1, 0).secondsLeft).toBe(30);
    expect(totpCode(SHA1, 1_000).secondsLeft).toBe(29);
    expect(totpCode(SHA1, 29_000).secondsLeft).toBe(1);
    expect(totpCode(SHA1, 30_000).secondsLeft).toBe(30);
  });

  it("counts down in the step the link asked for", () => {
    const uri = `otpauth://totp/x?secret=${SHA1}&period=60`;
    expect(totpCode(uri, 0).period).toBe(60);
    expect(totpCode(uri, 45_000).secondsLeft).toBe(15);
  });
});
