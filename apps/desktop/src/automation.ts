/**
 * Automation (Apple events) consent, per target app — the "Control other
 * apps" rows of the Capabilities tab.
 *
 * macOS keys this permission on the PAIR (responsible process → target app)
 * and asks the first time a pair is used, exactly as those prompts arrive for
 * Terminal or Script Editor. Nothing here is required: leave it and the first
 * script against an app simply prompts then. This lets the owner get those
 * prompts over with ahead of time, from a button they clicked on purpose.
 *
 * Reading the status is the host-gate helper's job (device-core's
 * `probes.automationStatus`, `AEDeterminePermissionToAutomateTarget` with
 * askUserIfNeeded off). What this module owns is the rest: the table of apps
 * agents are most often asked to drive, the one way to RAISE the prompt — an
 * `osascript` sending a real, gated, side-effect-free command (`count
 * windows`), the same binary, responsible process and TCC gate an agent's
 * script goes through, so whatever the probe does (prompt, allow, deny) is
 * exactly what the script would do — and the memo that remembers a verdict
 * for an app that is not running, since macOS declines to say for those.
 *
 * Adopted from the apple-events branch's pre-approvals dialog, whose modal
 * this tab replaces. Pure Node (no Electron import), runner injectable, so the
 * classification is unit-testable without ever touching macOS.
 */
import { execFile } from "node:child_process";
import type { AutomationStatus } from "@domo/device-core";

export interface AutomationApp {
  name: string;
  bundleId: string;
}

/** The apps the tab offers, the ones agents are most often asked to drive. */
export const AUTOMATION_APPS: readonly AutomationApp[] = Object.freeze([
  { name: "Messages", bundleId: "com.apple.MobileSMS" },
  { name: "Mail", bundleId: "com.apple.mail" },
  { name: "Calendar", bundleId: "com.apple.iCal" },
  { name: "Contacts", bundleId: "com.apple.AddressBook" },
  { name: "Notes", bundleId: "com.apple.Notes" },
  { name: "Reminders", bundleId: "com.apple.reminders" },
  { name: "Finder", bundleId: "com.apple.finder" },
  { name: "Safari", bundleId: "com.apple.Safari" },
]);

/** The offered app a name or bundle id refers to, case-insensitively. */
export function automationApp(nameOrId: string): AutomationApp | null {
  const wanted = nameOrId.trim().toLowerCase();
  return AUTOMATION_APPS.find((a) => a.name.toLowerCase() === wanted || a.bundleId.toLowerCase() === wanted) ?? null;
}

export interface ProbeOutcome {
  exitCode: number;
  stderr: string;
}

/**
 * Read the permission from a `count windows` probe's result.
 *
 * -1743 (errAEEventNotPermitted) / "Not authorized" is macOS refusing: denied.
 * A clean exit is granted. Any OTHER error means the event got PAST the gate to
 * an app-level problem (the app has no `windows`, say) — so permission was not
 * the obstacle, which is itself a grant. -1744 is consent still required (the
 * dialog was dismissed without an answer): not asked. Only a probe that never
 * reached the gate (osascript failed to launch) is unknown.
 */
export function classifyProbe(outcome: ProbeOutcome): AutomationStatus {
  if (/-1743\b/.test(outcome.stderr) || /Not authori[sz]ed/i.test(outcome.stderr)) return "denied";
  if (outcome.exitCode === 0) return "granted";
  if (/-1744\b/.test(outcome.stderr)) return "not_asked";
  if (/execution error/i.test(outcome.stderr)) return "granted";
  return "unknown";
}

/**
 * Merge a fresh passive read with the remembered verdict. `granted`, `denied`
 * and `not_asked` are macOS speaking and overwrite the memo (a revoked app
 * goes — and stays — denied; a reset one goes back to not asked). An
 * inconclusive read (a quit app, no helper) keeps what was remembered.
 */
export function reconcile(
  live: AutomationStatus,
  remembered: AutomationStatus | undefined,
): { status: AutomationStatus; memo: AutomationStatus | undefined; changed: boolean } {
  if (live === "granted" || live === "denied" || live === "not_asked") {
    return { status: live, memo: live, changed: live !== remembered };
  }
  return { status: remembered ?? live, memo: remembered, changed: false };
}

export type ProbeRunner = (bundleId: string) => Promise<ProbeOutcome>;

/**
 * Send the gated probe with osascript. Launches the target (the `tell` does),
 * so an undecided pair raises the prompt exactly as a real script would. Not
 * under the sandbox — the app's own identity is the one the grant is for.
 */
export function osascriptRunner(): ProbeRunner {
  return (bundleId) =>
    new Promise((resolve) => {
      execFile(
        "/usr/bin/osascript",
        ["-e", `tell application id "${bundleId}" to count windows`],
        { timeout: 120_000 },
        (error, _stdout, stderr) => {
          const code =
            error === null
              ? 0
              : typeof (error as { code?: unknown }).code === "number"
                ? (error as { code: number }).code
                : -1;
          resolve({ exitCode: code, stderr: String(stderr ?? "") });
        },
      );
    });
}

/**
 * Raise the prompt for one app. A bundle id not in the offered table never
 * reaches osascript, so the renderer cannot aim this anywhere the tab does
 * not offer.
 */
export async function requestAutomation(bundleId: string, run: ProbeRunner): Promise<AutomationStatus> {
  if (!AUTOMATION_APPS.some((a) => a.bundleId === bundleId)) return "unknown";
  return classifyProbe(await run(bundleId));
}
