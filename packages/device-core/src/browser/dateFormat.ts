/**
 * Render an ISO date the way a form wants it. The vault keeps one shape —
 * YYYY-MM-DD for a date of birth, YYYY-MM for a card's expiry — and the
 * page decides the other, saying so with a pattern.
 *
 * Tokens: YYYY YY MMMM MMM MM M DD D Do. Every non-letter passes through.
 * A letter that is not a token is refused rather than guessed — an agent
 * that typed `hh` gets told, not handed a wrong date. DD, D and Do need a
 * day, and a month-only date refuses them rather than guessing one.
 */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** This app's one extension of the pinned identity shape: ISO YYYY-MM-DD. */
export const DATE_OF_BIRTH = "date of birth";

/** A card's expiry as one date, composed at release from expMonth/expYear
 * (YYYY-MM). Listed, unlike full name: forms want it as one field far more
 * often than as two, and a format reshapes it. */
export const CARD_EXPIRY = "expiry";

/**
 * The labels a fill may reshape with a format. `shape` is the pattern used
 * when no format is given — empty means the value is typed exactly as
 * stored, which is right for a date already kept ISO. `sample` is a value
 * the given pattern is checked against before the vault is asked. `describe`
 * puts `shape` into words for DATE_FORMAT_HELP, since an empty shape has no
 * pattern of its own to show.
 */
export const DATE_LABELS: Record<string, { shape: string; sample: string; describe: string }> = {
  [DATE_OF_BIRTH]: { shape: "", sample: "2000-01-01", describe: "as stored (YYYY-MM-DD)" },
  [CARD_EXPIRY]: { shape: "MM/YY", sample: "2000-01", describe: "as MM/YY" },
};

const article = (word: string): string => (/^[aeiou]/i.test(word) ? "an" : "a");

const OWN_SHAPES = Object.entries(DATE_LABELS)
  .map(([label, d]) => `${article(label)} ${label} ${d.describe}`)
  .join(", ");

export const DATE_FORMAT_HELP =
  "format tokens: YYYY, YY, MMMM (November), MMM (Nov), MM (11), M (11 or 5), " +
  "DD (09), D (9), Do (9th); anything else is typed as written, e.g. 'MM/DD/YYYY' " +
  `or 'MMMM Do, YYYY'. Omit it for the field's own shape: ${OWN_SHAPES}. ` +
  "A card's expiry has no day, so DD, D and Do are refused on it.";

const TOKEN = /YYYY|YY|MMMM|MMM|MM|M|DD|Do|D|[A-Za-z]|[^A-Za-z]+/g;

function ordinal(day: number): string {
  const rest = day % 100;
  if (rest >= 11 && rest <= 13) return `${day}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th";
  return `${day}${suffix}`;
}

/** The numbers behind a stored date, or a refusal. A date of birth is
 * YYYY-MM-DD; a card's expiry is YYYY-MM, and then there is no day. */
export function parseIso(iso: string): { y: number; m: number; d: number | null } {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(iso);
  const bad = new Error("a date is stored as YYYY-MM-DD, or YYYY-MM for a month");
  if (match === null) throw bad;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = match[3] === undefined ? null : Number(match[3]);
  const probe = new Date(0);
  probe.setUTCFullYear(y, m - 1, d ?? 1);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== (d ?? 1)) throw bad;
  return { y, m, d };
}

export function formatDate(iso: string, pattern: string): string {
  const { y, m, d } = parseIso(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return pattern.replace(TOKEN, (piece) => {
    const day = (): number => {
      if (d === null) throw new Error(`'${piece}' needs a day, and this date has no day — it is a month and a year`);
      return d;
    };
    switch (piece) {
      case "YYYY": return String(y).padStart(4, "0");
      case "YY": return pad(y % 100);
      case "MMMM": return MONTHS[m - 1];
      case "MMM": return MONTHS[m - 1].slice(0, 3);
      case "MM": return pad(m);
      case "M": return String(m);
      case "DD": return pad(day());
      case "D": return String(day());
      case "Do": return ordinal(day());
      default:
        if (/^[A-Za-z]$/.test(piece)) {
          throw new Error(`'${piece}' is not a date token — ${DATE_FORMAT_HELP}`);
        }
        return piece;
    }
  });
}

const EXPIRY_ERROR = "a card expiry is a month 1-12 and a two- or four-digit year";

/** One stored part of a card's expiry, normalised (04, 2031), or a refusal.
 * Trimmed first: a box copy-pasted from a card reader routinely carries
 * surrounding whitespace. */
export function expiryPart(part: "expMonth" | "expYear", given: string): string {
  const trimmed = given.trim();
  if (part === "expMonth") {
    if (/^\d{1,2}$/.test(trimmed) && Number(trimmed) >= 1 && Number(trimmed) <= 12) return trimmed.padStart(2, "0");
  } else if (/^\d{2}$/.test(trimmed)) {
    return `20${trimmed}`;
  } else if (/^\d{4}$/.test(trimmed)) {
    return trimmed;
  }
  throw new Error(EXPIRY_ERROR);
}

/** A card's expiry as the month it is stored for, or null when either part is missing or malformed. */
export function expiryIso(month: string | null | undefined, year: string | null | undefined): string | null {
  try {
    return `${expiryPart("expYear", year ?? "")}-${expiryPart("expMonth", month ?? "")}`;
  } catch {
    return null;
  }
}
