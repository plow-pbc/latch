/* What the chat checklist is offered, worked out away from the DOM.

   The rule that needs its own home is the editor's: an agent's own chats must
   appear in the list even when the account's chat list does not contain them.
   That is not a rare shape — the chat list has a fallback (a Mac that could not
   reach `GET /v1/chats` is offered the one chat activation left it), and a chat
   the owner has since left is gone from the list while the agent still serves
   it. In both cases a checklist built from the account's chats alone silently
   omits a chat the agent has, and "save the boxes that are ticked" then detaches
   it — a chat the person never saw, removed by a click they did not aim at it.

   Pure so vitest can drive it; the renderer supplies the DOM. */

/**
 * The chats an editor for `agent` must show: the account's chats, plus any chat
 * the agent serves that is missing from them.
 *
 * The account's own order is kept — it is the order the picker uses, and two
 * lists that disagree about it would read as two different features. The
 * strays go after it, in the order the agent serves them, each labelled from
 * the row's own `chatLabels` (which already falls back to the raw uid, so an
 * unknown chat shows as something rather than as a blank line).
 *
 * `recipients: null` on a stray, deliberately: we do not know the numbers, and
 * the checklist must not invent them.
 *
 * A stray carries `title`/`subtitle` too, so the row renderer reads the same
 * two fields for every row rather than falling through to `label` for some of
 * them. The title is the stored label and the subtitle is EMPTY — a chat the
 * account list did not return has no participants and no line to format, and
 * an empty second line is the honest way to say so.
 */
/**
 * The order both chat lists are shown in: by the line each chat runs on, then
 * by the row's own title.
 *
 * A plain sort rather than group headers — the account has a handful of
 * numbers, and a header per number costs more rows than it saves. Chats on one
 * line end up adjacent anyway, which is the whole point.
 *
 * Locale-aware, because these are names people read, and STABLE, because the
 * server's order is the tiebreak we already trust. A chat whose line is
 * unnamed sorts last: an empty string first would put the least identifiable
 * rows at the top.
 */
export function sortChatRows(chats) {
  const compare = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  return [...(chats ?? [])].sort((a, b) => {
    const lineA = (a.lineName ?? "").trim();
    const lineB = (b.lineName ?? "").trim();
    if (!lineA !== !lineB) return lineA ? -1 : 1;
    const byLine = compare.compare(lineA, lineB);
    if (byLine !== 0) return byLine;
    return compare.compare(a.title ?? "", b.title ?? "");
  });
}

export function editorChats(agent, cloudChats) {
  const chats = [...(cloudChats ?? [])];
  const known = new Set(chats.map((chat) => chat.uid));
  const served = agent?.chatUids ?? [];
  const labels = agent?.chatLabels ?? [];
  served.forEach((uid, index) => {
    if (!uid || known.has(uid)) return;
    known.add(uid);
    const label = labels[index] || uid;
    chats.push({ uid, label, recipients: null, people: [], title: label, subtitle: "", lineName: null });
  });
  return chats;
}

/**
 * Is this agent's chat set safe to edit right now?
 *
 * It is not, while the account's chat list has never landed. The editor would
 * open on the fallback — one chat, or none — and every other chat on the
 * account would be missing from it. `editorChats` keeps what the agent SERVES
 * visible through that, but nothing can put back what the account has and this
 * Mac has not been told about, so the honest answer is to wait.
 */
export function canEditChats(agent, chatsLoaded) {
  return !!chatsLoaded && agent?.status === "running" && !agent?.localPending;
}

/** Add a chat without moving the current home at position zero. */
export function pickChat(chosen, uid) {
  return chosen.includes(uid) ? chosen : [...chosen, uid];
}

/** Remove a chat, promoting the earliest remaining list entry when it was home. */
export function dropChat(chosen, uid, order) {
  const next = chosen.filter((item) => item !== uid);
  return chosen[0] === uid ? next.sort((a, b) => order.indexOf(a) - order.indexOf(b)) : next;
}

/** Move a chosen chat to the home position. */
export function makeHome(chosen, uid) {
  return chosen.includes(uid) ? [uid, ...chosen.filter((item) => item !== uid)] : chosen;
}

/**
 * Do these two sets mean the same thing to the server?
 *
 * Home is `chat_uids[0]` and the rest is a set, so this compares home and
 * membership and NOT the order of the rest. Removing and re-adding a non-home
 * chat moves it within the array without changing what the server serves, so
 * comparing index for index would offer a restart for no actual change.
 */
export function sameChatSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  if ((a[0] ?? null) !== (b[0] ?? null)) return false;
  const inB = new Set(b);
  return a.every((uid) => inB.has(uid));
}
