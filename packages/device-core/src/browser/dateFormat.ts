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

export const DATE_FORMAT_HELP =
  "format tokens: YYYY, YY, MMMM (November), MMM (Nov), MM (11), M (11 or 5), " +
  "DD (09), D (9), Do (9th); anything else is typed as written, e.g. 'MM/DD/YYYY' " +
  "or 'MMMM Do, YYYY'. Omit it for the field's own shape: YYYY-MM-DD for a date of " +
  "birth, MM/YY for a card's expiry.";

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

/** One stored part of a card's expiry, normalised (04, 2031), or a refusal. */
export function expiryPart(part: "expMonth" | "expYear", given: string): string {
  if (part === "expMonth") {
    if (/^\d{1,2}$/.test(given) && Number(given) >= 1 && Number(given) <= 12) return given.padStart(2, "0");
  } else if (/^\d{2}$/.test(given)) {
    return `20${given}`;
  } else if (/^\d{4}$/.test(given)) {
    return given;
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
