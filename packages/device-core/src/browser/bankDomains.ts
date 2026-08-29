/**
 * A STARTER list of financial-institution registrable domains (eTLD+1).
 *
 * This is the SUPPLEMENT signal for the fail-closed banking-credential gate:
 * when the browser is about to type a credential into one of these sites (or a
 * subdomain of one), the release is treated as financial and must carry an
 * owner-approved payment approval first. See `financialGate.ts`.
 *
 * ── INTERIM, and it fails open for a bank not on it ─────────────────────────
 * This list is deliberately NOT exhaustive and CANNOT be: a bank it has never
 * heard of (and a credit card on an arbitrary merchant site) is not gated, so
 * the domain match is a best-effort TRIGGER, not the security boundary. The
 * reliable primitive is the OWNER-TAGGED-ITEM registry (an owner flag on the
 * vault item itself; see the metadata gap in `financialGate.ts` and the note in
 * `DESIGN.md`) — and, whichever way a release is triggered, the per-payment
 * owner approval consumed from plow is the real BACKSTOP: nothing is released on
 * the strength of this list alone. So do NOT treat "it's on the list" as the
 * guarantee; treat the owner approval as the guarantee and this as one way to
 * demand it. Over-matching here is the SAFE error — an extra approval prompt on
 * a non-bank costs a round-trip; a missed bank silently releases a banking
 * credential. When in doubt, ADD the domain.
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
