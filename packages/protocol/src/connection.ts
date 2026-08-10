/**
 * DomoConnection — twin of DomoProtocol/DomoConnection.swift. The single
 * thing a human ever copies to connect (URL + pin + token bundled).
 *
 * Wire nuance: the Swift payload encoder does NOT use .withoutEscapingSlashes,
 * so payload JSON escapes "/" as "\/". We match it so compact strings are
 * byte-identical across implementations (fixtures/connection.json).
 */
export interface DomoConnection {
  /** Broker endpoint the client dials. */
  url: string;
  /** SPKI pin (base64 SHA-256) for the broker cert. undefined ⇒ plain ws://. */
  pin?: string;
  /** Agent token. Present only in an agent connection string (a secret). */
  token?: string;
  /** Optional human label. */
  name?: string;
  /** Whether a device connecting here must run the enrollment challenge. */
  authenticate: boolean;
}

const COMPACT_PREFIX = "domo1.";

export const Base64URL = {
  encode(data: Buffer): string {
    return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(s: string): Buffer | null {
    let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    try {
      return Buffer.from(b64, "base64");
    } catch {
      return null;
    }
  },
};

function payloadJSON(conn: DomoConnection): Buffer {
  // Keys sorted; slashes escaped (see header comment). Fields mirror the
  // Swift Payload struct: u / pin / t / n / a (a omitted when false).
  const payload: { [k: string]: string | boolean | undefined } = {
    a: conn.authenticate ? true : undefined,
    n: conn.name,
    pin: conn.pin,
    t: conn.token,
    u: conn.url,
  };
  const keys = Object.keys(payload)
    .filter((k) => payload[k] !== undefined)
    .sort();
  const body = keys
    .map((k) => JSON.stringify(k) + ":" + JSON.stringify(payload[k]).replace(/\//g, "\\/"))
    .join(",");
  return Buffer.from("{" + body + "}", "utf8");
}

/** The compact copy-paste artifact: `domo1.<base64url(json)>`. */
export function compactString(conn: DomoConnection): string {
  return COMPACT_PREFIX + Base64URL.encode(payloadJSON(conn));
}

/** The deep link form for the app's `domo://` URL scheme. */
export function deepLink(conn: DomoConnection): string {
  return "domo://connect?c=" + Base64URL.encode(payloadJSON(conn));
}

export function connectionIsSecure(conn: DomoConnection): boolean {
  return conn.url.startsWith("wss://");
}

export function connectionIsNetworked(conn: DomoConnection): boolean {
  return conn.url.startsWith("ws://") || conn.url.startsWith("wss://");
}

/** Parse any accepted form; null if unrecognizable. */
export function parseConnection(raw: string): DomoConnection | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  if (text.startsWith(COMPACT_PREFIX)) {
    return decodePayload(text.slice(COMPACT_PREFIX.length));
  }
  if (text.startsWith("domo://")) {
    let c: string | null = null;
    try {
      c = new URL(text).searchParams.get("c");
    } catch {
      return null;
    }
    return c ? decodePayload(c) : null;
  }
  if (text.startsWith("ws://") || text.startsWith("wss://")) {
    return { url: text, authenticate: false };
  }
  return null;
}

function decodePayload(b64: string): DomoConnection | null {
  const data = Base64URL.decode(b64);
  if (!data) return null;
  try {
    const p = JSON.parse(data.toString("utf8")) as {
      u?: string;
      pin?: string;
      t?: string;
      n?: string;
      a?: boolean;
    };
    if (typeof p.u !== "string") return null;
    return {
      url: p.u,
      pin: p.pin,
      token: p.t,
      name: p.n,
      authenticate: p.a ?? false,
    };
  } catch {
    return null;
  }
}
