/**
 * Render an ISO date the way a form wants it. The vault keeps one shape
 * (YYYY-MM-DD); the page decides the other, and says so with a pattern.
 *
 * Tokens: YYYY YY MMMM MMM MM M DD D Do. Every non-letter passes through.
 * A letter that is not a token is refused rather than guessed — an agent
 * that typed `hh` gets told, not handed a wrong date.
 */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const DATE_FORMAT_HELP =
  "format tokens: YYYY, YY, MMMM (November), MMM (Nov), MM (11), M (11 or 5), " +
  "DD (09), D (9), Do (9th); anything else is typed as written, e.g. 'MM/DD/YYYY' " +
  "or 'MMMM Do, YYYY'. Omit it for YYYY-MM-DD.";

const TOKEN = /YYYY|YY|MMMM|MMM|MM|M|DD|Do|D|[A-Za-z]|[^A-Za-z]+/g;

function ordinal(day: number): string {
  const rest = day % 100;
  if (rest >= 11 && rest <= 13) return `${day}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th";
  return `${day}${suffix}`;
}

/** The three numbers, or a refusal: the vault stores exactly this shape. */
function parseIso(iso: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const bad = new Error("a date of birth is stored as YYYY-MM-DD");
  if (match === null) throw bad;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) throw bad;
  return { y, m, d };
}

export function formatDate(iso: string, pattern: string): string {
  const { y, m, d } = parseIso(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return pattern.replace(TOKEN, (piece) => {
    switch (piece) {
      case "YYYY": return String(y);
      case "YY": return pad(y % 100);
      case "MMMM": return MONTHS[m - 1];
      case "MMM": return MONTHS[m - 1].slice(0, 3);
      case "MM": return pad(m);
      case "M": return String(m);
      case "DD": return pad(d);
      case "D": return String(d);
      case "Do": return ordinal(d);
      default:
        if (/^[A-Za-z]$/.test(piece)) {
          throw new Error(`'${piece}' is not a date token — ${DATE_FORMAT_HELP}`);
        }
        return piece;
    }
  });
}
