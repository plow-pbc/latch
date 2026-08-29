/**
 * The accepted v1 registry of financial-institution registrable domains
 * (eTLD+1).
 *
 * This is the detection signal for the banking-credential gate:
 * when the browser is about to type a credential into one of these sites (or a
 * subdomain of one), the release is treated as financial and must carry an
 * owner-approved payment approval first. See `financialGate.ts`.
 *
 * ── Accepted residual ────────────────────────────────────────────────────────
 * This list is deliberately not exhaustive. An unlisted institution, or a
 * credit card filled on an arbitrary merchant site, does not trigger the gate.
 * That fail-open gap is accepted for v1. For every listed exact domain and
 * subdomain, the per-payment owner approval remains mandatory and fail-closed.
 * Over-matching costs an extra approval prompt; a missed institution remains
 * outside this v1 gate. Add a domain when real usage exposes a gap, without
 * adding a second registry or item-tagging system.
 *
 * Extend by appending the registrable domain (eTLD+1) only — no scheme, no
 * subdomain, no path. `financialGate.ts` generates BOTH the exact `domain` and
 * the `*.domain` wildcard from each bare entry here, and it needs both:
 * `originMatches` exact-matches a bare `chase.com` and covers `secure.chase.com`
 * / `www.chase.com` ONLY through the generated `*.chase.com`. So one bare eTLD+1
 * per bank is all you add — do not hand-write subdomains, and do not drop the
 * wildcard half in `financialGate.ts` or subdomains silently stop matching.
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
  "bmoharris.com",
  "bmo.com",
  "santanderbank.com",
  "firstrepublic.com",
  "synchrony.com",
  "synchronybank.com",
  "barclaycardus.com",
  "comerica.com",
  "zionsbank.com",
  "flagstar.com",

  // Large multinational banks — an owner may hold a US or non-US account with
  // any of these, so a fill into one is a bank fill wherever the person lives.
  "hsbc.com",
  "barclays.co.uk",
  "barclays.com",
  "natwest.com",
  "lloydsbank.com",
  "santander.co.uk",
  "monzo.com",
  "revolut.com",
  "wise.com",
  "rbc.com",
  "td.com",
  "scotiabank.com",
  "cibc.com",

  // Large brokerages / cash-management accounts (a wire out of one moves money
  // the same way a bank does).
  "schwab.com",
  "fidelity.com",
  "vanguard.com",
  "morganstanley.com",
  "goldmansachs.com",
  "marcus.com",
  "etrade.com",
  "robinhood.com",
  "coinbase.com",
];
