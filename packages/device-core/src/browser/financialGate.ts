/**
 * The fail-closed gate that blocks releasing a BANKING credential unless an
 * owner-approved payment approval exists.
 *
 * This module holds two things:
 *   1. DETECTION — is a given credential release "financial"?
 *   2. The client SEAM — `PaymentApprovalClient` — that (in real life) will ask
 *      the plow cloud whether the owner approved this payment.
 *
 * Enforcement lives in `BrowserSessions.fillSecret()`: it runs detection on the
 * DEVICE-observed destination host (which the agent cannot spoof), and — when
 * the release is financial — requires `checkPaymentApproval` to return
 * `approved: true` BEFORE the vault is asked for the value. Anything else
 * (not approved, an error, a timeout, or no endpoint at all) is treated as NOT
 * approved and the release is blocked. This is money-security code: when in
 * doubt, FAIL CLOSED.
 *
 * ── DETECTION signal, and the metadata gap ──────────────────────────────────
 * The spec's PRIMARY signal is "the vault item is owner-flagged financial". No
 * such clean flag is available from the broker:
 *   - vaultwarden rejects the bank-account / passport / driving-licence cipher
 *     types (see `cli.py` `_CATEGORY_BY_TYPE`), so a bank login is stored as an
 *     ordinary LOGIN — indistinguishable, by category, from any other login.
 *   - `describe-item` / `whats-here` expose no folder, tag, or collection.
 *   - The only inherently-financial category is CREDIT_CARD, but reading it in
 *     the release path would need a `describe-item` call, and that path is
 *     contractually a single reading of the item with no describe (see
 *     `fillSecretMasking.test.ts` "asks the vault once per fill …").
 *
 * So detection here relies on the SUPPLEMENT signal: the device-observed
 * destination host matches a bundled bank-domain list (`bankDomains.ts`). That
 * host is what the browser actually resolved for the field, so it is the
 * unspoofable "am I about to type a credential into a bank?" question.
 *
 * TODO(plow-approval-PR): add an owner-flag signal once available. The cheapest
 * shape that does not break the single-reading contract is to have the broker's
 * `get-field` return the item CATEGORY (and/or an owner "financial" folder/tag)
 * alongside `value`+`hidden`, so a CREDIT_CARD or owner-flagged item is gated
 * with no extra round-trip and no time-of-check/time-of-use window.
 */
import { originMatches } from "@domo/protocol";
import { BANK_ETLD1_DOMAINS } from "./bankDomains.js";

/** Host-suffix patterns for the bundled bank domains: exact host + any
 * subdomain. `originMatches` already implements the label-suffix comparison the
 * rest of the browser layer uses, so a bank domain is gated the same way an
 * approved origin is matched — no public-suffix list. */
const BANK_PATTERNS: string[] = BANK_ETLD1_DOMAINS.flatMap((d) => [d, `*.${d}`]);

export interface FinancialAssessment {
  /** True when this release must pass the owner-approval gate before it may
   * proceed. */
  gated: boolean;
  /** Why it was gated, for the audit line. Never a value, never a full URL. */
  reason: string;
  /** The destination host the approval is bound to — null when it could not be
   * read (which is itself a reason to gate). */
  domain: string | null;
}

/**
 * Is this credential release financial, and therefore owner-gated?
 *
 * `frameHost` is the host of the DEVICE-observed frame the field lives in
 * (already validated against the session's origins by the caller). It is
 * financial when that host is, or sits under, a bundled bank domain.
 *
 * A host that could not be read (null/empty) is treated as GATED — fail closed.
 * An unknown destination cannot be ruled out as a bank, and this is money code,
 * so ambiguity blocks rather than releases.
 */
export function assessFinancialRelease(frameHost: string | null): FinancialAssessment {
  if (frameHost === null || frameHost === "") {
    return {
      gated: true,
      reason: "financial gate: destination host could not be read (fail closed)",
      domain: null,
    };
  }
  if (originMatches(frameHost, BANK_PATTERNS)) {
    return {
      gated: true,
      reason: "financial gate: destination is a known bank domain",
      domain: frameHost,
    };
  }
  return { gated: false, reason: "", domain: frameHost };
}

/** What the enforcement layer asks about a financial release. */
export interface PaymentApprovalRequest {
  /** The (already one-way-digested) session id, for correlating an approval to
   * the browser session that needs it. */
  sessionId: string;
  /** The destination host the release is bound to. */
  domain: string;
}

/** The answer. `approved: true` is the ONLY thing that lets a financial release
 * through; a `reason` may accompany a denial for the audit line. */
export interface PaymentApprovalResult {
  approved: boolean;
  reason?: string;
}

/**
 * The seam. A real implementation consults the plow cloud for an owner-approved
 * payment approval bound to this session + domain.
 */
export interface PaymentApprovalClient {
  checkPaymentApproval(request: PaymentApprovalRequest): Promise<PaymentApprovalResult>;
}

/**
 * The default until the plow-side approval mint exists.
 *
 * There is no endpoint to ask yet, so there is no approval to be had, so every
 * financial release is denied. This is the fail-closed state this PR ships in —
 * intended and safe: it BLOCKS banking-credential releases rather than letting
 * one through unapproved. Swap it for the real client when the plow-side PR
 * lands; until then, do NOT deploy this gate expecting financial releases to
 * succeed — by design, none will.
 */
export const NO_APPROVAL_ENDPOINT: PaymentApprovalClient = {
  async checkPaymentApproval(): Promise<PaymentApprovalResult> {
    return { approved: false, reason: "no owner-approval endpoint is configured yet" };
  },
};
