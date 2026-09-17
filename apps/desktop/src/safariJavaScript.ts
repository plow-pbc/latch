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
  for (const key of ["IncludeDevelopMenu", "AllowJavaScriptFromAppleEvents"]) {
    const w = await run([DEFAULTS, "write", DOMAIN, key, "-bool", "true"]);
    if (w.exitCode !== 0) throw new Error("Safari's settings could not be written — this app needs Full Disk Access (Settings › Permissions)");
  }
  if (wasRunning) await run(["/usr/bin/open", "-a", "Safari"]);
  return { relaunched: wasRunning };
}
