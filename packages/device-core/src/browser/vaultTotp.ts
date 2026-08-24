/**
 * The six digits an authenticator key is FOR.
 *
 * The vault stores the key; a key is not what anyone types into a login form.
 * Everything below turns the stored string into the code of the moment, so the
 * Vault tab can show it and the owner can read it off their own screen.
 *
 * `bw get totp` already does this, and is what an agent's fill goes through.
 * That is a 130MB process start per code, and the owner's side of this app
 * deliberately stopped shelling out to the CLI (see vaultClient). Node's own
 * crypto has HMAC-SHA1, and base32 is a table, so this needs no dependency and
 * no process.
 *
 * RFC 6238 over RFC 4226, with the parameters a stored otpauth:// URI is
 * allowed to change: digits, period, and the hash.
 */
import crypto from "node:crypto";

/** What an authenticator key says about how its codes are built. */
export interface TotpParams {
  /** The shared secret, decoded from base32. */
  secret: Buffer;
  digits: number;
  /** Seconds each code lasts. */
  period: number;
  algorithm: "sha1" | "sha256" | "sha512";
}

export interface TotpCode {
  code: string;
  period: number;
  /** Seconds this code still has. Never 0: a code about to turn over reads 1. */
  secondsLeft: number;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Base32 (RFC 4648) without padding, spaces or case.
 *
 * People paste what the site showed them, and sites show the key in lowercase
 * four-character groups. Refusing that would refuse the common case, so the
 * separators every issuer uses are stripped before decoding — and a character
 * that is not base32 at all is still an error, because silently dropping it
 * would produce a key that is wrong rather than one that is refused.
 */
export function base32Decode(raw: string): Buffer {
  const clean = raw.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!clean) throw new Error("that authenticator key is empty");
  // The mistake worth naming, because it is the one everybody makes: "TOTP"
  // means the six digits to anyone who is not implementing one, and digits
  // alone are never a key — base32 has no 0, 1 or 8 in it at all.
  if (/^[0-9]+$/.test(clean)) {
    throw new Error(
      "that is a code, not a key — the key is the longer letters-and-numbers string the site shows under its QR code",
    );
  }
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const at = ALPHABET.indexOf(ch);
    if (at === -1) throw new Error(`${JSON.stringify(ch)} is not part of an authenticator key`);
    value = (value << 5) | at;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bytes.length === 0) throw new Error("that authenticator key is too short to hold a secret");
  return Buffer.from(bytes);
}

const HASHES = new Set(["sha1", "sha256", "sha512"]);

/**
 * The parameters behind whatever the owner stored.
 *
 * Two shapes reach us and both are ordinary: the bare key a site prints under
 * its QR code, and the whole `otpauth://` URI that the QR code itself encodes.
 * The URI wins where it disagrees with the defaults, because its author meant
 * it — an issuer using 8 digits or a 60-second step is rare but real, and
 * showing that account a 6-digit 30-second code would just be wrong.
 */
export function totpParams(stored: string): TotpParams {
  const raw = stored.trim();
  if (!raw) throw new Error("this item has no authenticator key");
  let secret = raw;
  let digits = 6;
  let period = 30;
  let algorithm: TotpParams["algorithm"] = "sha1";

  if (/^otpauth:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("that authenticator key is an otpauth link this app cannot read");
    }
    // `otpauth://hotp/...` counts logins, not seconds; its codes cannot be
    // derived from the clock, so saying so beats showing a wrong number.
    if (url.host.toLowerCase() !== "totp") {
      throw new Error(`this app can only show codes for otpauth://totp, not ${url.host}`);
    }
    const p = url.searchParams;
    const given = p.get("secret");
    if (!given) throw new Error("that otpauth link carries no secret");
    secret = given;
    // A parameter that is present but nonsense is refused rather than
    // defaulted: the code it would produce is indistinguishable from a right
    // one until it is rejected on a site.
    const readNumber = (name: string, fallback: number, low: number, high: number): number => {
      const text = p.get(name);
      if (text === null) return fallback;
      const n = Number(text);
      if (!Number.isInteger(n) || n < low || n > high) {
        throw new Error(`that otpauth link asks for ${name}=${text}, which is not a value this app can use`);
      }
      return n;
    };
    digits = readNumber("digits", 6, 6, 10);
    period = readNumber("period", 30, 1, 300);
    const named = (p.get("algorithm") ?? "sha1").toLowerCase();
    if (!HASHES.has(named)) {
      throw new Error(`that otpauth link asks for ${named}, which is not a hash this app can use`);
    }
    algorithm = named as TotpParams["algorithm"];
  }
  return { secret: base32Decode(secret), digits, period, algorithm };
}

/** One code, for the counter step RFC 4226 calls C. */
function hotp(params: TotpParams, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac(params.algorithm, params.secret).update(message).digest();
  // Dynamic truncation (RFC 4226 §5.3): the low nibble of the last byte picks
  // where the four bytes we keep begin.
  const at = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(at) & 0x7fffffff;
  return String(binary % 10 ** params.digits).padStart(params.digits, "0");
}

/**
 * The code this key is showing right now, and how long it lasts.
 *
 * `atMs` is a parameter so the RFC's own vectors can be checked against it, and
 * so a caller that already knows the moment does not race the clock between
 * asking for the code and asking how long it has left.
 */
export function totpCode(stored: string, atMs: number = Date.now()): TotpCode {
  const params = totpParams(stored);
  const seconds = Math.floor(atMs / 1000);
  const code = hotp(params, Math.floor(seconds / params.period));
  return {
    code,
    period: params.period,
    secondsLeft: params.period - (seconds % params.period),
  };
}
