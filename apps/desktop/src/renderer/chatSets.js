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
 */
export function editorChats(agent, cloudChats) {
  const chats = [...(cloudChats ?? [])];
  const known = new Set(chats.map((chat) => chat.uid));
  const served = agent?.chatUids ?? [];
  const labels = agent?.chatLabels ?? [];
  served.forEach((uid, index) => {
    if (!uid || known.has(uid)) return;
    known.add(uid);
    chats.push({ uid, label: labels[index] || uid, recipients: null });
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

/* ---- The checklist's selection, as data -------------------------------------

   A chat set is two facts — which chats, and which of them is home — and the
   rules that keep them consistent are small, total, and worth pinning down away
   from checkboxes. Each of these takes a selection and answers a new one; the
   checklist holds the result and repaints from it.

   A selection is `{ chosen: string[], home: string | null }`. `chosen` carries
   no order of its own: order is a question about a LIST, so every function that
   needs it is handed one. */

const selectionOf = (selection) => ({
  chosen: [...new Set((selection?.chosen ?? []).filter(Boolean))],
  home: selection?.home ?? null,
});

/**
 * The set as it goes on the wire: home first, then the rest.
 *
 * `order` is the list the person is looking at. `keepOrder` — the set the agent
 * already serves — comes first among the rest, in ITS order, so a save that
 * changes nothing sends back exactly what it was given: re-ordering chats
 * nobody touched would restart an agent to say the same thing.
 *
 * Home is prepended only if it is still chosen. Unchecking the home chat asks
 * this for the next one, and a version that trusted `home` blindly answered
 * with the chat that had just been removed.
 */
export function orderedChats(selection, order = [], keepOrder = []) {
  const { chosen, home } = selectionOf(selection);
  const picked = new Set(chosen);
  const out = home && picked.has(home) ? [home] : [];
  const seen = new Set(out);
  for (const uid of [...keepOrder, ...order]) {
    if (!picked.has(uid) || seen.has(uid)) continue;
    seen.add(uid);
    out.push(uid);
  }
  // Anything the caller never listed still belongs to the person who picked it.
  for (const uid of chosen) if (!seen.has(uid)) out.push(uid);
  return out;
}

/** Check a chat. The first chat chosen is home until someone says otherwise. */
export function chooseChat(selection, uid) {
  const { chosen, home } = selectionOf(selection);
  if (!uid) return { chosen, home };
  const next = chosen.includes(uid) ? chosen : [...chosen, uid];
  return {
    chosen: next,
    home: home && next.includes(home) ? home : uid,
  };
}

/** Uncheck a chat. Home is always one of the chosen, so ★ is handed on. */
export function dropChat(selection, uid, order = []) {
  const { chosen, home } = selectionOf(selection);
  const next = chosen.filter((candidate) => candidate !== uid);
  if (home !== uid) return { chosen: next, home };
  return { chosen: next, home: orderedChats({ chosen: next, home: null }, order)[0] ?? null };
}

/** Move ★. Only a chosen chat can be home, so an unchosen one is ignored. */
export function makeHomeChat(selection, uid) {
  const { chosen, home } = selectionOf(selection);
  return { chosen, home: chosen.includes(uid) ? uid : home };
}

/**
 * Do these two sets mean the same thing to the server?
 *
 * Home is `chat_uids[0]` and the rest is a set, so this compares home and
 * membership and NOT the order of the rest. Comparing index for index made a
 * three-chat agent open with Save alive — the checklist orders by the account's
 * chat list, the server answers in its own order, and the two agree only by
 * luck — one click from restarting an agent to tell it what it already knew.
 */
export function sameChatSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  if ((a[0] ?? null) !== (b[0] ?? null)) return false;
  const inB = new Set(b);
  return a.every((uid) => inB.has(uid));
}
