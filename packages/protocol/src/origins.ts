/**
 * Origin patterns for browser capabilities.
 *
 * A pattern is an explicit host ("dominos.com") or a wildcard over subdomains
 * ("*.dominos.com"). Matching is pure label-suffix comparison — no public
 * suffix list, no eTLD+1 inference. What the approver saw on the card is
 * exactly what matches; "dominos.com" and "*.dominos.com" are two entries.
 */

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
