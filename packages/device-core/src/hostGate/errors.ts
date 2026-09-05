/**
 * Reading an error for what it can actually tell us — and no more.
 *
 * A failure reaches the diagnosis as text: Node's own `EPERM: operation not
 * permitted, open '/x'`, wrapped by `FileOpsError` as `read failed: …`, or a
 * command's stderr, which is whatever the program chose to print. These
 * helpers pull the errno, the syscall and the paths out of that text. They
 * are the TRIGGER for a diagnosis, never its verdict: `hostGate/diagnose.ts`
 * confirms what they suggest by probing.
 */

/** The errno names a refusal on this Mac can wear. Anything else is kept
 *  verbatim, so an unexpected code still reaches the evidence. */
export type Errno = "EPERM" | "EACCES" | "ENOENT" | "EROFS" | "ENOTDIR" | "EISDIR" | string;

/**
 * What a command's stderr says about why it failed, reduced to the few shapes
 * this Mac knows how to follow up on. Free text from a program is never a
 * verdict, but it is a fine reason to go and probe.
 */
export type StderrHint =
  | "operation_not_permitted"
  | "permission_denied"
  | "no_such_file"
  | "sqlite_unable_to_open"
  | "apple_event_not_permitted"
  | "read_only_filesystem";

export function stderrHint(output: string): StderrHint | null {
  // Order matters only where two patterns can share a line, and the more
  // specific one goes first.
  if (/unable to open database file/i.test(output)) return "sqlite_unable_to_open";
  if (/-1743\b|errAEEventNotPermitted|not authori[sz]ed to send apple events/i.test(output)) {
    return "apple_event_not_permitted";
  }
  if (/read-only file system/i.test(output)) return "read_only_filesystem";
  if (/operation not permitted/i.test(output)) return "operation_not_permitted";
  if (/permission denied/i.test(output)) return "permission_denied";
  if (/no such file or directory/i.test(output)) return "no_such_file";
  return null;
}

/** The errno a stderr hint stands in for, where it stands in for one. */
export function errnoFromHint(hint: StderrHint | null): Errno | null {
  switch (hint) {
    case "operation_not_permitted": return "EPERM";
    case "permission_denied": return "EACCES";
    case "no_such_file": return "ENOENT";
    case "read_only_filesystem": return "EROFS";
    default: return null;
  }
}

/** How many paths a diagnosis will probe for one failure. Probing is cheap
 *  but not free — each is a child process with a timeout — and a command
 *  line can name hundreds. */
export const MAX_CANDIDATE_PATHS = 8;

/**
 * Absolute (or `~`-relative) paths mentioned in a command line or its output,
 * in order of appearance, deduplicated and bounded. Quotes and trailing
 * punctuation are stripped because stderr wraps paths in both. Relative
 * paths are not guessed at: the cwd they were relative to is the run's, and
 * a wrong guess would probe the wrong file and confidently blame it.
 */
/** What a shell word may glue after a path: a closing quote, a comma, the
 *  sentence's own stop. */
const TRAILING_PUNCTUATION = new Set(["'", '"', "`", ",", ";", ":", ".", ")", "]", "}", ">"]);

export function candidatePaths(texts: readonly string[], limit = MAX_CANDIDATE_PATHS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    for (const line of text.split(/\r?\n/)) {
      const words = line.split(/\s+/).filter((w) => w.length > 0);
      // `/bin/sh: /x: Operation not permitted` — the first word of a stderr
      // line, colon-terminated, is the program reporting, not the path it is
      // reporting about. Dropped only when the line names something else,
      // so a line that is nothing but a path keeps it.
      if (words.length > 1 && words[0]!.endsWith(":") && words.slice(1).some((w) => /(?:^|[=:'"`])~?\//.test(w))) {
        words.shift();
      }
      for (const raw of words) {
      // A shell word may glue a flag or a key to the path: `--db=/x`, `key:/x`.
      const at = raw.search(/(?:^|[=:'"`])(~?\/)/);
      if (at < 0) continue;
      let token = raw.slice(at).replace(/^[=:'"`]+/, "");
      // Trailing quote and punctuation, trimmed by hand: a `+$` over a
      // character class backtracks per repetition on a word that is mostly
      // quotes, and this text is a command's own output.
      let end = token.length;
      while (end > 0 && TRAILING_PUNCTUATION.has(token[end - 1]!)) end -= 1;
      token = token.slice(0, end);
      if (!(token.startsWith("/") || token === "~" || token.startsWith("~/"))) continue;
      // A bare "/" is the filesystem, not a file anyone failed to open.
      if (token === "/") continue;
      if (seen.has(token)) continue;
      seen.add(token);
      out.push(token);
      if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/**
 * Paths a command line names, element by element: an argv word that IS a
 * path is taken whole, spaces and all — `["cat", "/Users/x/My Report.txt"]`
 * is one path, not two — and any other word is mined the way free text is
 * (`--db=/x`). Joining argv into a line first would split the spaced one.
 */
export function argvCandidates(argv: readonly string[], limit = MAX_CANDIDATE_PATHS): string[] {
  const out: string[] = [];
  for (const word of argv) {
    const whole = word === "~" || word.startsWith("~/") || (word.startsWith("/") && word !== "/");
    for (const p of whole ? [word] : candidatePaths([word], limit)) {
      if (!out.includes(p)) out.push(p);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * The application an AppleScript in `argv` addresses — `tell application
 * "Messages"` — so a refused send can be checked against that target's
 * Automation consent. The first target only: a script that drives two apps
 * is diagnosed on the first, and the evidence says which.
 */
export function appleEventTarget(argv: readonly string[]): string | null {
  const m = /tell\s+(?:application|app)\s+"([^"]+)"/i.exec(argv.join(" "));
  return m ? m[1]! : null;
}
