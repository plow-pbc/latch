/* The Vault tab's search: a pure match over one listed item, kept out of the
   pane so it can be tested without a DOM.

   The haystack is everything the listing carries — the title, the context
   line, every URL, every field including the secrets, and the notes — and the
   type's own name, so "card" finds the cards. The vault decides which secrets
   a listing carries (none, for an item that asks for the owner first); this
   file matches on whatever it was given and draws nothing. */

/** Lower-cased and stripped of accents, so "Delattre" finds "Délattre". */
function fold(s) {
  return String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Every searchable string of one listed item, in the clear. */
export function vaultHaystack(summary, typeLabel = "") {
  return [
    summary.title,
    summary.subtitle,
    ...(summary.urls || []),
    ...Object.values(summary.fields || {}),
    ...Object.values(summary.secrets || {}),
    summary.notes,
    typeLabel,
  ].filter((v) => typeof v === "string" && v !== "");
}

/**
 * Whether one listed item matches a query. Every whitespace-separated word of
 * the query must appear somewhere in the item, in any order, in any field —
 * "amex travel" finds a card whose brand is Amex and whose notes say travel.
 * An empty (or all-space) query matches everything.
 */
export function vaultMatches(summary, query, typeLabel = "") {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = vaultHaystack(summary, typeLabel).map(fold);
  return words.every((w) => hay.some((h) => h.includes(w)));
}
