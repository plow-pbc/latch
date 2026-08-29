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
 * ── DETECTION signal ─────────────────────────────────────────────────────────
 * Detection uses the accepted v1 bank-domain registry in `bankDomains.ts`.
 * The device-observed destination host is what the browser actually resolved
 * for the field, so an agent cannot spoof the host checked here. A listed exact
 * domain or subdomain fails closed through the owner-approval consume step.
 * Unlisted institutions and cards filled on arbitrary merchant sites are an
 * accepted v1 residual: they do not trigger this gate. See `bankDomains.ts` for
 * the deliberately simple process for maintaining the registry.
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
