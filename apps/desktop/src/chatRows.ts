import { echoesCredential } from "./cloudAgents.js";

/**
 * How a chat reads in the picker: a title of the people in it, and one
 * subtitle line naming the number it runs on and the numbers it reaches.
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

/**
 * The row's entries, in the ONE order both lines use: the line this chat runs
 * on, then its participants as the API listed them.
 *
 * Built once and mapped twice, because the title and the subtitle are the same
 * list said two ways — a name per entry above, a number per entry below — and
 * the whole value of the pair is that the third name belongs to the third
 * number. Two functions walking the participants separately would be two
 * chances for that to stop being true.
 */
function rowEntries(
  line: string | null,
  lineName: string | null,
  people: readonly ChatPerson[],
): { label: string; number: string }[] {
  const lineNumber = (line ?? "").trim();
  const entries: { label: string; number: string }[] = [];
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
 * The chat's title: the line's name, then who is in it.
 *
 * `Willow, You, Nina` — and where a participant has no name, their number
 * stands in for it: `Ash, You, +1 916-520-4946`. The owner is always "You".
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
  const labels = rowEntries(line, lineName, people).map((entry) => entry.label);
  return labels.length ? labels.join(", ") : fallback;
}

/**
 * The numbers under the title, in the SAME ORDER and with no names:
 * `+1 650-346-6610, +1 330-554-1942, +1 201-805-1467`.
 *
 * Positional on purpose. The title says who, this says which number each of
 * them is, and the reader joins them by position — so nothing here may filter
 * or reorder what the title kept.
 */
export function chatRowSubtitle(
  line: string | null,
  lineName: string | null,
  people: readonly ChatPerson[],
): string {
  return rowEntries(line, lineName, people).map((entry) => entry.number).join(", ");
}
