import { echoesCredential } from "./cloudAgents.js";

/**
 * How a chat reads in the picker: one entry per position — the number it runs
 * on, then the people in it — each carrying the name and the number together.
 *
 * Pure, and separate from `cloudAgentState` for the reason `viewModel.ts` is
 * separate from the approval window: this is the part with rules in it — who
 * counts as a participant, which number is the owner's, how a number is
 * spelled — and rules want tests, not a display.
 *
 * Every string here is server-authored. Callers set them with `textContent`.
 */

/** One human in a chat, as the API describes them. */
export interface ChatPerson {
  /** Their address. E.164 when the provider has one. */
  number: string;
  /** Their name, when the provider supplied a usable one. */
  name: string | null;
  /**
   * Whether this is the Mac's owner.
   *
   * Taken from the API's own `role === "owner"` (`parseActivationChat`), NOT
   * inferred by intersecting numbers across chats. The intersection is wrong
   * on the two cases that matter: an account with ONE chat, where every number
   * in it is "common to every chat", and a household where the same second
   * person is in all of them. The server knows which participant owns the
   * chat; nothing here has to guess.
   */
  isOwner: boolean;
}

/**
 * Does an IDENTIFIER on this chat repeat the credential?
 *
 * The uid, the line, and each participant's number — the fields that cannot be
 * blanked and still mean anything. A chat that answers true is dropped whole by
 * its callers.
 *
 * Names are the other half and are handled by `withoutCredentialEchoes`: a
 * chat whose NAME echoes is still a real chat with real numbers, and blanking
 * the name is both safe and useful, where dropping the row would lose a chat
 * the owner has.
 *
 * One rule, because two callers hold the credential: the chat-list client, and
 * the redeem that persists `provisionedChatLabel`. The second had no check at
 * all, so a `line` echoing the session token was written to disk and rendered.
 */
export function chatEchoesCredential(
  chat: {
    uid: string;
    line: string | null;
    participants: readonly { providerKey: string | null }[];
  },
  credential: string,
): boolean {
  const identifiers = [
    chat.uid,
    chat.line ?? "",
    ...chat.participants.map((member) => member.providerKey ?? ""),
  ];
  return identifiers.some((value) => echoesCredential(value.trim(), credential));
}

/** The same chat with any name that echoes the credential removed. */
export function withoutCredentialEchoes<
  T extends {
    displayName: string | null;
    participants: readonly { displayName: string | null }[];
  },
>(chat: T, credential: string): T {
  return {
    ...chat,
    displayName: echoesCredential(chat.displayName ?? "", credential) ? null : chat.displayName,
    participants: chat.participants.map((member) =>
      echoesCredential(member.displayName ?? "", credential) ? { ...member, displayName: null } : member,
    ),
  };
}

/**
 * What separates one entry from the next in a FLAT label.
 *
 * Only where a row has to collapse to a single string with no numbers beside
 * it — the activation label on disk, and the picker's fallback. Nothing reads
 * it back: the row a human sees is built from `chatRowEntries`, where a name
 * and its number are one object, so a display name that happens to contain
 * this separator is just a name.
 */
const ENTRY_SEPARATOR = " · ";

/**
 * A display name worth showing, or null.
 *
 * Rejects a name that merely repeats the handle beside it and a name that is
 * just a phone number: both put a number where a reader is looking for a
 * person, and the number has a place of its own on the row.
 */
export function usableChatDisplayName(
  value: string | null,
  providerKey: string | null = null,
): string | null {
  const name = (value ?? "").trim();
  const handle = (providerKey ?? "").trim();
  const phoneNumberShaped = /[0-9]/.test(name) && /^[0-9+ (),-]+$/.test(name);
  if (!name || name === handle || phoneNumberShaped) return null;
  return name;
}

/**
 * The participants of a chat, as everything that PRESENTS them sees them.
 *
 * The one place the API's participant shape becomes people: the picker's rows,
 * the setup window's label and the cloud-agent state all read this, so "who is
 * in this chat, and which of them is the owner" is answered once.
 */
export function chatPeople(chat: {
  participants: readonly { providerKey: string | null; displayName: string | null; isOwner: boolean }[];
}): ChatPerson[] {
  return chat.participants.flatMap((member) => {
    const number = (member.providerKey ?? "").trim();
    if (!number) return [];
    return [{
      number,
      name: usableChatDisplayName(member.displayName, member.providerKey),
      isOwner: member.isOwner,
    }];
  });
}

/**
 * `+16503156536` → `+1 650-315-6536`.
 *
 * NANP only, because that is the shape plow's lines and their members take.
 * Anything else — a longer country code, a number that is not one — is
 * returned verbatim rather than chopped into groups that would misread it.
 */
export function formatNumber(number: string): string {
  const raw = (number ?? "").trim();
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(raw);
  return nanp ? `+1 ${nanp[1]}-${nanp[2]}-${nanp[3]}` : raw;
}

/** One position on a chat row: who, and which number they are. */
export interface ChatRowEntry {
  /** "You" for the owner, the line's or the person's name where there is a
   * usable one, and their formatted number where there is not. */
  label: string;
  /** The same entry's number, formatted. */
  number: string;
}

/**
 * The row, as the picker draws it: the line this chat runs on, then its
 * participants as the API listed them.
 *
 * A name and its number are ONE object all the way to the DOM, so a reader
 * never has to line up two strings by counting. They used to be exactly that
 * — a title and a subtitle joined on a separator a display name cannot
 * contain — and "cannot contain" is a promise about server-authored text that
 * nothing here can keep: `Willow · Home` is a line name a provider will hand
 * over, and it added a position to the top line with no number under it.
 */
export function chatRowEntries(
  line: string | null,
  lineName: string | null,
  people: readonly ChatPerson[],
): ChatRowEntry[] {
  const lineNumber = (line ?? "").trim();
  const entries: ChatRowEntry[] = [];
  if (lineNumber) {
    // The line leads. It is the number the chat runs on — the one an agent
    // here answers from — and naming it first is what tells two chats with the
    // same people apart.
    entries.push({
      label: lineName?.trim() || formatNumber(lineNumber),
      number: formatNumber(lineNumber),
    });
  }
  for (const person of people) {
    if (person.number === lineNumber) continue;
    const label = person.isOwner ? "You" : person.name?.trim() || formatNumber(person.number);
    entries.push({ label, number: formatNumber(person.number) });
  }
  return entries;
}

/**
 * The same row flattened to ONE string: `Willow · You · Nina`.
 *
 * For the two places that have room for a row and not for its numbers — the
 * activation label persisted in settings, and the picker's own tooltip and
 * accessible name. Where a participant has no name their number stands in for
 * it (`Ash · You · +1 916-520-4946`); the owner is always "You".
 *
 * `fallback` covers the row with nothing to name at all: the settings fallback
 * chat, which persists a label and no participants and no line.
 */
export function chatRowTitle(
  people: readonly ChatPerson[],
  line: string | null,
  fallback: string,
  lineName: string | null = null,
): string {
  const labels = chatRowEntries(line, lineName, people).map((entry) => entry.label);
  return labels.length ? labels.join(ENTRY_SEPARATOR) : fallback;
}
