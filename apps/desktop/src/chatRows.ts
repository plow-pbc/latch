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

/** That person, as the title names them: their name, "You", or their number. */
function personLabel(person: ChatPerson): string {
  if (person.isOwner) return "You";
  return person.name?.trim() || formatNumber(person.number);
}

/**
 * The chat's title: who is in it.
 *
 * The LINE is excluded. It is Plow's own number, not a participant anyone
 * thinks of themselves as talking to, and it is named in the subtitle — a
 * title that repeated it made every chat on one line look alike.
 *
 * `fallback` is used when nothing is left to name, which is a real state: a
 * 1:1 between the owner and the line has one participant, and dropping the
 * line from a chat the parser gave no members at all leaves none.
 */
export function chatRowTitle(people: readonly ChatPerson[], line: string | null, fallback: string): string {
  const others = people.filter((person) => person.number !== (line ?? ""));
  const named = others.map(personLabel).filter((label) => label.length > 0);
  return named.length ? named.join(", ") : fallback;
}

/**
 * The one line under the title: which number this chat runs on, then the
 * numbers it reaches.
 *
 * `Ash · +1 650-315-6536 — You +1 330-554-1942, +1 916 520-4946`
 *
 * The line appears ONCE, here, and never in the title — a number printed twice
 * on one row reads as two numbers. Participants keep their names beside their
 * numbers so a three-person thread stays readable left to right; the row
 * ellipsises rather than wraps, and carries the whole string as its tooltip.
 */
export function chatRowSubtitle(
  line: string | null,
  lineName: string | null,
  people: readonly ChatPerson[],
): string {
  const number = (line ?? "").trim();
  const head = number
    ? [lineName?.trim(), formatNumber(number)].filter(Boolean).join(" · ")
    : "";
  const others = people
    .filter((person) => person.number !== number)
    .map((person) => {
      const label = person.isOwner ? "You" : person.name?.trim() || "";
      const formatted = formatNumber(person.number);
      return label ? `${label} ${formatted}` : formatted;
    })
    .filter((entry) => entry.trim().length > 0);
  if (!head) return others.join(", ");
  return others.length ? `${head} — ${others.join(", ")}` : head;
}
