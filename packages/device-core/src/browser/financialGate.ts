/**
 * The fail-closed gate that blocks releasing a BANKING credential unless an
 * owner-approved payment approval exists.
 *
 * This module holds two things:
 *   1. DETECTION — `isFinancialDestination`: is a given credential release
 *      "financial"?
 *   2. The client SEAM — `PaymentApprovalClient` — that asks the plow cloud
 *      whether the owner approved this payment (single-use CONSUME).
 *
 * Enforcement lives in `BrowserSessions.fillSecret()`: it runs detection on the
 * DEVICE-observed destination host (which the agent cannot spoof), and — when
 * the release is financial — requires `consumePaymentApproval` to return
 * `approved: true` BEFORE the vault is asked for the value. Anything else
 * (not approved, an error, a non-2xx, a timeout, or no client wired at all) is
 * treated as NOT approved and the release is blocked. This is money-security
 * code: when in doubt, FAIL CLOSED. The fail-closed collapse is a single
 * try/catch in `fillSecret` around this call — the transport (PlowApi) owns its
 * own request timeout, so there is no separate timeout state machine here.
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
 * unspoofable "am I about to type a credential into a bank?" question. The
 * domain list is an INTERIM trigger and fails open for an unlisted bank; the
 * reliable primitive is the OWNER-TAGGED-ITEM registry described in
 * `DESIGN.md`, and the per-payment owner approval is the real backstop. See
 * `bankDomains.ts` for how to extend the interim list.
 *
 * TODO(owner-tagged-item registry): add an owner-flag signal once available.
 * The cheapest shape that does not break the single-reading contract is to have
 * the broker's `get-field` return the item CATEGORY (and/or an owner "financial"
 * folder/tag) alongside `value`+`hidden`, so a CREDIT_CARD or owner-flagged item
 * is gated with no extra round-trip and no time-of-check/time-of-use window.
 */
import { originMatches } from "@domo/protocol";
import { BANK_ETLD1_DOMAINS } from "./bankDomains.js";

/** Host-suffix patterns for the bundled bank domains: exact host + any
 * subdomain. `originMatches` already implements the label-suffix comparison the
 * rest of the browser layer uses, so a bank domain is gated the same way an
 * approved origin is matched — no public-suffix list. */
const BANK_PATTERNS: string[] = BANK_ETLD1_DOMAINS.flatMap((d) => [d, `*.${d}`]);

/**
 * Is this credential release financial, and therefore owner-gated?
 *
 * `frameHost` is the host of the DEVICE-observed frame the field lives in,
 * already validated against the session's origins by the caller (which also
 * rejects a null/empty host, so this is never asked about one). It is financial
 * when that host is, or sits under, a bundled bank domain.
 */
export function isFinancialDestination(frameHost: string): boolean {
  return originMatches(frameHost, BANK_PATTERNS);
}

/** What the enforcement layer asks about a financial release. */
export interface PaymentApprovalRequest {
  /** The authenticated Plow agent credential's session id. Plow keys the
   * approval created by that agent to this canonical database identity. */
  sessionId: string;
  /** The destination host the release is bound to. */
  domain: string;
}

/** The answer from the plow consume endpoint. `approved: true` is the ONLY
 * thing that lets a financial release through. */
export interface PaymentApprovalResult {
  approved: boolean;
}

/**
 * The seam. A real implementation CONSUMES a single-use owner payment approval
 * from the plow cloud bound to this session + domain: a `true` answer consumes
 * the approval, so this is called exactly once, at the moment of release.
 *
 * Fail-closed contract: the enforcement layer treats a thrown error (network
 * failure, non-2xx, timeout) exactly like an explicit `approved: false` — both
 * block. An implementation therefore need not translate transport failures into
 * `approved: false`; it may simply let them throw.
 */
export interface PaymentApprovalClient {
  consumePaymentApproval(request: PaymentApprovalRequest): Promise<PaymentApprovalResult>;
}
