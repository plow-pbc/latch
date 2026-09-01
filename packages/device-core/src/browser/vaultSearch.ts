/**
 * The Vault tab's search, as a pure match over one item's strings. It lives
 * here, not in the renderer, so that the strings it reads — secrets among
 * them — never have to leave the main process: the tab sends a query and
 * gets back the ids that match.
 */

/** Lower-cased and stripped of accents, so "Delattre" finds "Délattre". */
function fold(s: string): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** The query as the words that must each be found; empty for a blank query. */
export function searchWords(query: string): string[] {
  return fold(String(query ?? "")).split(/\s+/).filter(Boolean);
}

/**
 * Whether one item, given as its strings in the clear, matches. Every word
 * of the query must appear somewhere, in any order, in any string — "amex
 * travel" finds a card whose brand is Amex and whose notes say travel. No
 * words (a blank query) matches everything.
 */
export function haystackMatches(haystack: readonly string[], words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const hay = haystack.map(fold);
  return words.every((w) => hay.some((h) => h.includes(w)));
}
