/**
 * JSON wire values and canonical encoding — the TypeScript twin of
 * DomoProtocol's JSONValue/Canonical. Canonical bytes are what signatures
 * cover, so this encoder must stay byte-identical to the Swift one
 * (fixtures/canonical-json.json is the conformance oracle):
 *   - object keys sorted by UTF-16 code unit (all protocol keys are ASCII;
 *     never introduce non-ASCII keys — the two languages' sort orders are only
 *     proven equal for ASCII)
 *   - forward slashes NOT escaped; control chars as \n \r \t \b \f or
 *     lowercase \u00xx; DEL and non-ASCII raw (UTF-8)
 *   - integral numbers without a decimal point ("1", never "1.0")
 *   - dates are pre-rendered ISO-8601 strings (seconds precision, Z suffix)
 *   - undefined properties are omitted entirely
 */

export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue | undefined };

export function canonicalJSON(value: JSONValue | undefined): string {
  if (value === undefined || value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) throw new Error("non-finite number in JSON");
      // String() matches Swift's rendering for every value the protocol uses
      // (integral doubles print bare; shortest-round-trip fractions). Values
      // where the two diverge (-0, |n| >= 1e21) must never enter signed data.
      return String(value);
    }
    case "string":
      // JSON.stringify's string escaping matches Swift's
      // .withoutEscapingSlashes output (verified against the fixtures).
      return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJSON(v)).join(",") + "]";
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(value[k]!)).join(",") +
    "}"
  );
}

export function canonicalBytes(value: JSONValue | undefined): Buffer {
  return Buffer.from(canonicalJSON(value), "utf8");
}

export function parseJSON(data: Buffer | string): JSONValue {
  return JSON.parse(typeof data === "string" ? data : data.toString("utf8")) as JSONValue;
}

/**
 * Fluent accessor mirroring Swift's `JSONValue` subscripts, so ported code
 * keeps its shape: `jv(params).get("agent").get("id").str`.
 * Missing keys/indices resolve to null, never throw.
 */
export class JV {
  constructor(public readonly value: JSONValue | undefined) {}

  get(keyOrIndex: string | number): JV {
    const v = this.value;
    if (typeof keyOrIndex === "number") {
      if (Array.isArray(v) && keyOrIndex >= 0 && keyOrIndex < v.length) {
        return new JV(v[keyOrIndex]);
      }
      return new JV(null);
    }
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const child = (v as { [k: string]: JSONValue | undefined })[keyOrIndex];
      return new JV(child === undefined ? null : child);
    }
    return new JV(null);
  }

  get str(): string | null {
    return typeof this.value === "string" ? this.value : null;
  }
  get num(): number | null {
    return typeof this.value === "number" ? this.value : null;
  }
  get int(): number | null {
    return typeof this.value === "number" ? Math.trunc(this.value) : null;
  }
  get bool(): boolean | null {
    return typeof this.value === "boolean" ? this.value : null;
  }
  get arr(): JSONValue[] | null {
    return Array.isArray(this.value) ? this.value : null;
  }
  get obj(): { [k: string]: JSONValue | undefined } | null {
    const v = this.value;
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as { [k: string]: JSONValue | undefined })
      : null;
  }
  get isNull(): boolean {
    return this.value === null || this.value === undefined;
  }
}

export function jv(value: JSONValue | undefined): JV {
  return new JV(value);
}

/** ISO-8601 with seconds precision and Z suffix — Swift's .iso8601 strategy. */
export function isoNow(offsetSeconds = 0): string {
  return isoFromDate(new Date(Date.now() + offsetSeconds * 1000));
}

export function isoFromDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function parseISO(s: string): Date {
  return new Date(s);
}
