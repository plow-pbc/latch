/**
 * A STARTER list of financial-institution registrable domains (eTLD+1).
 *
 * This is the SUPPLEMENT signal for the fail-closed banking-credential gate:
 * when the browser is about to type a credential into one of these sites (or a
 * subdomain of one), the release is treated as financial and must carry an
 * owner-approved payment approval first. See `financialGate.ts`.
 *
 * Deliberately NOT exhaustive. It covers the major US retail banks, a few large
 * brokerages that hold cash balances, and `sofi.com`, because enumerating every
 * bank on earth is a losing game and the owner-flag signal (see the metadata
 * gap in `financialGate.ts`) is the long-term primary. Over-matching here is the
 * SAFE error — an extra approval prompt on a non-bank costs a round-trip; a
 * missed bank silently releases a banking credential, which is the exact failure
 * this list exists to prevent. So when in doubt, ADD the domain.
 *
 * Extend by appending the registrable domain (eTLD+1) only — no scheme, no
 * subdomain, no path. Matching is host-suffix (`domain` and `*.domain`), so
 * `chase.com` already covers `secure.chase.com`, `www.chase.com`, etc.
 */
export const BANK_ETLD1_DOMAINS: readonly string[] = [
  // Fintech / the one explicitly named in the spec.
  "sofi.com",

  // Largest US retail / commercial banks.
  "chase.com",
  "bankofamerica.com",
  "wellsfargo.com",
  "citi.com",
  "citibank.com",
  "capitalone.com",
  "usbank.com",
  "pnc.com",
  "truist.com",
  "tdbank.com",
  "ally.com",
  "citizensbank.com",
  "fifththird.com",
  "53.com",
  "regions.com",
  "keybank.com",
  "mtb.com",
  "huntington.com",
  "americanexpress.com",
  "discover.com",
  "usaa.com",
  "navyfederal.org",

  // Large brokerages / cash-management accounts (a wire out of one moves money
  // the same way a bank does).
  "schwab.com",
  "fidelity.com",
  "vanguard.com",
  "morganstanley.com",
  "goldmansachs.com",
  "marcus.com",
];
