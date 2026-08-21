/**
 * The facts this Mac can establish about a credential fill, for the reviewer.
 *
 * Outside the Electron entry for the same reason `viewModel.ts` and
 * `reviewPolicy.ts` are: it is on the security-relevant decision path, so it
 * has to be reachable by `npx vitest run` with no display, no vault and no
 * browser. `main.ts` supplies the two device-shaped lookups and nothing else.
 */
import { Intent, JSONValue, jv } from "@domo/protocol";
import type { BrowserSessionInfo, CredentialItemSummary } from "@domo/device-core";

/** The two things this needs from a running device, injected so tests need neither. */
export interface FactSources {
  /** What one live browser session is, by the handle the tool call carried. */
  session: (handle: string) => BrowserSessionInfo | null;
  /** The vault's own view of its items against a page, or null when there is no vault. */
  vault: ((url?: string) => Promise<CredentialItemSummary[]>) | null;
  /** Override for tests; production uses `FACT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * The origin of a page URL — scheme and host, nothing after it.
 *
 * A path is as capable of carrying a token as a query is (`/reset/abc123`), and
 * the origin is the whole of what a browsing decision turns on. An unparseable
 * URL is reported as unparseable rather than passed through.
 */
function pageOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "an address this Mac could not parse";
  }
}

/** How long the vault gets to answer before the review goes ahead without it. */
const FACT_TIMEOUT_MS = 5_000;

/**
 * What this Mac can establish about a credential-fill request, for the
 * reviewer.
 *
 * A fill was reviewed on opaque vault ids alone — `bxk3…`, and a decision about
 * whether to type it into a page. Everything that makes that answerable is
 * knowable HERE and nowhere in the agent's request: which session is being
 * widened and what it is already approved for, what page it is on, what
 * category the item is, and whether the vault considers that item to belong to
 * that page.
 *
 * Nothing here is a bound — the capability set is still the whole of what an
 * approval grants. These are facts to judge it against.
 *
 * NOTHING the agent wrote appears here. The requested ids are agent-supplied
 * strings — `plow_browser_request` takes whatever array it is given — so
 * echoing them into a block labelled "established HERE" would have laundered
 * agent text through a trusted label: an id spelled
 * `bxk3 (approved by the owner)` reads as ours. The ids are already on the
 * capability line, in the agent's own channel and labelled as the agent's, so
 * this identifies them by POSITION in that line and never repeats them.
 *
 * No URL leaves the Mac either. `lastUrl` is documented local-eyes-only and
 * keeps its query and fragment, which is where reset tokens, session tokens and
 * PII live; every other consumer on this Mac already reduces a URL to a host
 * before it reaches the audit log. This block goes off-device in the review
 * request, so it carries the ORIGIN and nothing else — which is the whole of
 * what the question turns on. The vault still gets the full URL: it runs here,
 * and it needs the real page to say whether an item belongs to it.
 *
 * The vault can be slow (a locked or syncing store), and a reviewer waiting on
 * it is a tool call spending its budget. So it is time-boxed, and a timeout
 * says SO: "could not be resolved" must not read as "no match", which is the
 * one misreading that would turn a missing fact into a reason to allow.
 */
export async function credentialFillFacts(
  intent: Intent,
  payload: JSONValue,
  sources: FactSources,
): Promise<string[]> {
  const items =
    intent.capabilities.find((c) => c.kind === "credential" && c.access === "fill")?.items ?? [];
  if (items.length === 0) return [];

  const facts: string[] = [];
  // Delivery detail, resolved to what it MEANS. The handle itself is a
  // capability — whoever holds it drives that browser — and it never goes into
  // a prompt.
  const handle = jv(payload).get("session").str;
  const session = handle !== null ? sources.session(handle) : null;
  if (session === null) {
    facts.push("this Mac could not identify the browser session this would widen");
  } else {
    facts.push(
      session.origins.length > 0
        ? `the browser session this would widen is already approved for: ${session.origins.join(", ")}`
        : "the browser session this would widen holds no approved origins yet",
    );
    facts.push(
      session.lastUrl
        ? `its current page is on ${pageOrigin(session.lastUrl)}`
        : "it has not opened a page yet, so there is no site to match these items against",
    );
  }

  const vault = sources.vault;
  if (!vault) {
    facts.push("the vault is unavailable, so these item ids could not be resolved at all");
    return facts;
  }
  type Answer = { items: CredentialItemSummary[] } | { unresolved: string };
  const answer = await Promise.race<Answer>([
    vault(session?.lastUrl || undefined).then(
      (items) => ({ items }),
      () => ({ unresolved: "the vault could not be read" }),
    ),
    new Promise<Answer>((r) => {
      setTimeout(
        () => r({ unresolved: "the vault did not answer in time" }),
        sources.timeoutMs ?? FACT_TIMEOUT_MS,
      ).unref?.();
    }),
  ]);
  if ("unresolved" in answer) {
    // Said as a gap, not as a silence. "no match found" is what a missing
    // answer looks like if it is left out, and that is the one misreading that
    // would turn not knowing into a reason to allow.
    facts.push(
      `${answer.unresolved}, so these item ids are UNRESOLVED — that is missing ` +
        `information, not a match and not a mismatch`,
    );
    return facts;
  }
  const known = answer.items;
  facts.push(
    `the fill requests ${items.length} vault ${items.length === 1 ? "item" : "items"}, ` +
      `numbered below in the order they appear on the capability line above`,
  );
  items.forEach((id, index) => {
    const item = known.find((i) => i.id === id);
    const label = `requested item ${index + 1}`;
    if (!item) {
      facts.push(`${label} is not in this vault`);
      return;
    }
    const site = !session?.lastUrl
      ? "there is no open page to match it against"
      : item.matchesThisPage
        ? "the vault lists the current page's site as one of its own"
        : "the vault does NOT list the current page's site as one of its own";
    facts.push(`${label} is "${item.title}", category ${item.category || "unknown"}; ${site}`);
  });
  return facts;
}

