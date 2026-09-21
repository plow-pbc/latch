/**
 * Which macOS login session this app was launched into — and what to tell the
 * owner when it is the wrong one.
 *
 * A GUI app inherits the launchd domain of whatever started it. Opened from
 * Finder, the Dock, or a login item, that is `Aqua`, the owner's GUI session.
 * Opened by a terminal that is itself outside Aqua — a tmux server, an ssh
 * shell, a script, an agent-driven install — the app lands in `Background`,
 * and so does every command the executor spawns.
 *
 * There macOS speech synthesis produces nothing: `say` writes no samples,
 * exits 0, and says nothing on stderr, so the agent reports success, the audit
 * log records a clean run, and the Mac stays silent. Measured on macOS 14.5
 * and 26.6.2, sandboxed and unsandboxed both ways: seatbelt AND Background
 * together are what break it, neither alone does, and no sandbox profile
 * rescues it — `(allow default)` fails in Background and the app's own
 * generated profile speaks in Aqua. Quitting and reopening from Finder is the
 * entire fix, which is why this is a sentence rather than a workaround.
 *
 * Nothing here is a bound on what a command may do: the session is not a
 * capability, and this warns rather than refuses because a Background launch
 * is a degraded app, not an unsafe one.
 *
 * Pure over the session name (the `loginItem.ts` shape) so the rule is
 * testable without Electron; the probe beside it is the one impure line.
 */
import { execFileSync } from "node:child_process";

/** What the owner is shown, once, at launch. */
export interface LaunchSessionWarning {
  message: string;
  detail: string;
}

/**
 * The launchd session this process is in — `Aqua`, `Background`,
 * `StandardIO` — or "" when the question could not be asked.
 *
 * Empty is deliberately not an error: a Mac that will not answer is one this
 * knows nothing about, and the answer to knowing nothing is to say nothing.
 */
export function managerName(): string {
  try {
    return execFileSync("/bin/launchctl", ["managername"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/**
 * The warning for a session, or null when there is nothing to say.
 *
 * Anything that is not Aqua warns, rather than a list of the two names macOS
 * uses today: a session this does not recognise is one whose services this app
 * cannot vouch for either. An unreadable probe ("") is the one silent case —
 * a modal on every launch would cost more than the bug it guesses at.
 */
export function launchSessionWarning(session: string): LaunchSessionWarning | null {
  if (session === "" || session === "Aqua") return null;
  return {
    message: "Plow Latch is running outside your Mac's desktop session",
    detail:
      `Something outside your desktop session opened it — a terminal, an ssh connection, a ` +
      `script — so macOS put it in the "${session}" session instead.\n\n` +
      "Commands run from here cannot reach the speech synthesiser — `say` reports success " +
      "and the Mac stays silent — and other services that belong to the desktop session " +
      "can fail the same way, without an error.\n\n" +
      "Quit Plow Latch and open it again from Finder or the Dock.",
  };
}
