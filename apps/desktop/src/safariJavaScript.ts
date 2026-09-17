/**
 * Safari's "Allow JavaScript from Apple Events" — the one setting the Safari
 * fallback needs (camoufox-browsing skill) — performed for the owner from the
 * Plugins tab. Two facts shape it, both measured on a real Mac (macOS 14.5):
 * the write goes through `defaults` into Safari's container and needs Full
 * Disk Access, which this app already asks for; and a pref written while
 * Safari is running is overwritten with Safari's cached value when it quits,
 * so Safari is quit first and relaunched after. Pure over a runner.
 */
export type Runner = (argv: string[]) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

const DEFAULTS = "/usr/bin/defaults";
const DOMAIN = "com.apple.Safari";

export async function safariJavaScriptEnabled(run: Runner): Promise<boolean> {
  const r = await run([DEFAULTS, "read", DOMAIN, "AllowJavaScriptFromAppleEvents"]);
  return r.exitCode === 0 && r.stdout.trim() === "1";
}

async function safariRunning(run: Runner): Promise<boolean> {
  return (await run(["/usr/bin/pgrep", "-x", "Safari"])).exitCode === 0;
}

export async function enableSafariJavaScript(run: Runner): Promise<{ relaunched: boolean }> {
  const wasRunning = await safariRunning(run);
  if (wasRunning) {
    await run(["/usr/bin/osascript", "-e", 'quit app "Safari"']);
    for (let i = 0; i < 20 && (await safariRunning(run)); i++) await new Promise((r) => setTimeout(r, 500));
    if (await safariRunning(run)) throw new Error("Safari did not quit; close it and try again");
  }
  // A failed write must not strand the owner with Safari quit and no
  // explanation why — the relaunch below runs whether or not it succeeded.
  let writeFailed = false;
  for (const key of ["IncludeDevelopMenu", "AllowJavaScriptFromAppleEvents"]) {
    if (writeFailed) break;
    const w = await run([DEFAULTS, "write", DOMAIN, key, "-bool", "true"]);
    if (w.exitCode !== 0) writeFailed = true;
  }
  if (wasRunning) {
    const opened = await run(["/usr/bin/open", "-a", "Safari"]);
    // A relaunch failure is only reported when the write itself succeeded —
    // otherwise it would mask the more fundamental Full Disk Access failure.
    if (!writeFailed && opened.exitCode !== 0) {
      throw new Error("Safari's setting is on, but Safari did not relaunch — open it yourself");
    }
  }
  if (writeFailed) throw new Error("Safari's settings could not be written — this app needs Full Disk Access (Settings › Permissions)");
  return { relaunched: wasRunning };
}
