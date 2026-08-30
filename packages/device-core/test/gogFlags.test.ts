/**
 * The arguments a caller may not supply to gog.
 *
 * gog resolves repeated global flags LAST-WINS and accepts them after the
 * command path, and caller argv reaches gog verbatim. Verified live at 0.36.0:
 * a `gmail send` that is refused before network dispatch under `--readonly`
 * reached Google when `--readonly=false` was appended. Without this refusal the
 * belt flags are decorative, so these rows are the gate itself, not hardening
 * around it.
 */
import { describe, expect, it } from "vitest";
import { filePathsIn, reservedFlagIn } from "../src/providers/gogFlags.js";

describe("reservedFlagIn", () => {
  // The third column pins WHAT comes back, not just that something did: a
  // regression in the `=` split would return "--readonly=false" and every
  // not-null assertion would still pass, which is exactly how agent text
  // reaches an error string.
  const refused: [string, string[], string][] = [
    ["disarms --readonly (verified live at 0.36.0)", ["gmail", "send", "--readonly=false"], "--readonly"],
    ["disarms --readonly, space-separated", ["gmail", "send", "--readonly", "false"], "--readonly"],
    ["disarms the send block", ["gmail", "send", "--gmail-no-send=false"], "--gmail-no-send"],
    ["disarms the injection wrapper", ["gmail", "search", "x", "--wrap-untrusted=false"], "--wrap-untrusted"],
    ["reopens the command gate", ["gmail", "get", "1", "--enable-commands-exact", "gmail.trash"], "--enable-commands-exact"],
    ["reopens the command gate, prefix form", ["gmail", "get", "1", "--enable-commands", "gmail"], "--enable-commands"],
    ["disables a command the gate relies on", ["gmail", "get", "1", "--disable-commands", "x"], "--disable-commands"],
    ["re-enables interactive prompting", ["gmail", "get", "1", "--no-input=false"], "--no-input"],
    ["repoints gog's config root", ["gmail", "get", "1", "--home", "/tmp/evil"], "--home"],
    ["supplies a different token", ["gmail", "get", "1", "--access-token", "AAA"], "--access-token"],
  ];

  it.each(refused)("refuses: %s", (_why, argv, expected) => {
    expect(reservedFlagIn(argv)).toBe(expected);
  });

  it("cannot be switched off by leading with a terminator", () => {
    // gog itself rejects a flag after `--` (verified at 0.36.0), and this gate
    // has no terminator branch to disable — one would have handed a caller an
    // off switch for the whole scan.
    expect(reservedFlagIn(["--", "gmail", "send", "--readonly=false"])).toBe("--readonly");
  });

  const allowed: [string, string[]][] = [
    ["a plain search", ["gmail", "search", "newer_than:7d"]],
    ["json output", ["gmail", "get", "18abcdef", "--json"]],
    // A read-side boolean whose name merely contains a refused word must still
    // pass, or the rule costs a legitimate call.
    ["a read-side attachment boolean", ["gmail", "messages", "search", "x", "--include-attachments"]],
    ["attachment content on stdout", ["gmail", "attachment", "1", "2", "--inline"]],
    ["a calendar range", ["calendar", "events", "primary", "--from", "2026-09-01T00:00:00Z"]],
    // Single-dash words are skipped: kong refuses the single-dash spelling of
    // a long flag, so one can only be a positional.
    ["a single-dash positional", ["gmail", "search", "--", "-weird"]],
  ];

  it.each(allowed)("allows: %s", (_why, argv) => {
    expect(reservedFlagIn(argv)).toBeNull();
  });
});

describe("filePathsIn", () => {
  it.each([
    ["an attachment", ["gmail", "send", "--attach", "/tmp/photo.jpg"], ["/tmp/photo.jpg"], []],
    ["joined attachments", ["gmail", "send", "--attach=/tmp/a.jpg,/tmp/b.pdf"], ["/tmp/a.jpg", "/tmp/b.pdf"], []],
    ["a body file", ["gmail", "send", "--body-file=/tmp/body.txt"], ["/tmp/body.txt"], []],
    ["a future input-file flag", ["gmail", "send", "--future-file", "/tmp/in"], ["/tmp/in"], []],
    ["an output file", ["gmail", "attachment", "1", "2", "--out", "/tmp/a.pdf"], [], ["/tmp/a.pdf"]],
    ["an output directory", ["gmail", "thread", "get", "1", "--out-dir=/tmp/mail"], [], ["/tmp/mail"]],
  ] as const)("derives %s from argv", (_why, argv, read, write) => {
    expect(filePathsIn(argv)).toEqual({ read: [...read], write: [...write] });
  });

  it("ignores stdin and flag-looking positionals after the terminator", () => {
    expect(filePathsIn(["gmail", "send", "--body-file", "-", "--", "--outdated"])).toEqual({
      read: [],
      write: [],
    });
  });
});
