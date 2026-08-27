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
