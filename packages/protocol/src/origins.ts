/**
 * Origin patterns for browser capabilities.
 *
 * A pattern is an explicit host ("dominos.com") or a wildcard over subdomains
 * ("*.dominos.com"). Matching is pure label-suffix comparison — no public
 * suffix list, no eTLD+1 inference. What the approver saw on the card is
 * exactly what matches; "dominos.com" and "*.dominos.com" are two entries.
 */
import { Hashing } from "./identity.js";

/**
 * Normalize a pattern to the form rule keys hash: lowercase, no scheme, no
 * port, no path, no trailing dot. A leading "*." wildcard is preserved.
 */
export function normalizeOrigin(pattern: string): string {
  let p = pattern.trim().toLowerCase();
  const wildcard = p.startsWith("*.");
  if (wildcard) p = p.slice(2);
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  p = p.replace(/[/?#].*$/, ""); // path/query/fragment
  p = p.replace(/:\d+$/, ""); // port
  p = p.replace(/\.$/, ""); // trailing dot
  return wildcard ? `*.${p}` : p;
}

/** True when `host` matches any pattern. Wildcards match proper subdomains only. */
export function originMatches(host: string, patterns: string[]): boolean {
  const h = normalizeOrigin(host);
  if (h === "") return false;
  return patterns.some((raw) => {
    const p = normalizeOrigin(raw);
    if (p.startsWith("*.")) {
      const base = p.slice(2);
      return base !== "" && h.endsWith("." + base);
    }
    return h === p;
  });
}

/**
 * Directory name for the browser profile a grant may write to. Same
 * normalization `normalizedCapability()` uses for rule keys, so a session
 * opened against a remembered rule lands back in the profile that rule built.
 *
 * Keyed on the whole approved set rather than on a registrable domain,
 * deliberately: this module infers no eTLD+1, and a profile keyed on one would
 * be a wider store than the card the owner approved — `*.costco.com` state
 * would be handed to a session granted only `sameday.costco.com`. Set-keying
 * costs sharing between grants that overlap without being equal; that is the
 * safe direction, since the narrower grant is the one that goes without.
 */
export function profileKeyForOrigins(origins: string[]): string {
  // Length-prefixed, so the encoding is injective: a pattern that happens to
  // contain the separator cannot spell a different set that hashes the same.
  // These come straight from a tool argument, so "no host looks like that"
  // is not something this function gets to assume.
  const patterns = [...new Set(origins.map((o) => normalizeOrigin(o)))].sort();
  // A grant with nothing usable in it would otherwise share one profile with
  // every other such grant. It can only arrive from a bug upstream — the tool
  // already refuses an empty list — so say so rather than picking a store.
  if (patterns.some((p) => p === "" || p === "*.")) {
    throw new Error(`profileKeyForOrigins: empty origin in ${JSON.stringify(origins)}`);
  }
  if (patterns.length === 0) throw new Error("profileKeyForOrigins: no origins");
  const key = patterns.map((o) => `${o.length}:${o}`).join("");
  return Hashing.sha256Hex(Buffer.from(key, "utf8")).slice(0, 16);
}
