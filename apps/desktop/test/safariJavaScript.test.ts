import { describe, expect, it } from "vitest";
import { enableSafariJavaScript, safariJavaScriptEnabled, type Runner } from "../src/safariJavaScript.js";

/** A runner that records argv and answers from a script keyed on argv[0]+argv[1]. */
function fake(answers: Record<string, { exitCode?: number; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    const a = answers[argv.slice(0, 2).join(" ")] ?? {};
    return { exitCode: a.exitCode ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { run, calls };
}

/** Wraps a runner so pgrep -x Safari reports "running" once (before quit) then
 *  "gone" — the shape enableSafariJavaScript polls for once it has asked
 *  Safari to quit. Shared by every scenario that starts with Safari open. */
function quittingSafari(base: Runner): Runner {
  let asked = 0;
  return async (argv) => {
    if (argv[0] === "/usr/bin/pgrep") return { exitCode: asked++ === 0 ? 0 : 1, stdout: asked === 1 ? "123\n" : "", stderr: "" };
    return base(argv);
  };
}

describe("safariJavaScriptEnabled", () => {
  it.each([["1\n", true], ["0\n", false], ["", false]])("reads %j as %s", async (out, want) => {
    const { run } = fake({ "/usr/bin/defaults read": { stdout: out, exitCode: out ? 0 : 1 } });
    expect(await safariJavaScriptEnabled(run)).toBe(want);
  });
});

describe("enableSafariJavaScript", () => {
  it("quits a running Safari before writing, writes the pref, then relaunches it", async () => {
    const { run, calls } = fake({});
    const result = await enableSafariJavaScript(quittingSafari(run));
    expect(result).toEqual({ relaunched: true });
    const order = calls.map((c) => c.join(" "));
    const quit = order.findIndex((c) => c.startsWith("/usr/bin/osascript -e quit app \"Safari\""));
    const write = order.findIndex((c) => c === "/usr/bin/defaults write com.apple.Safari AllowJavaScriptFromAppleEvents -bool true");
    const open = order.findIndex((c) => c === "/usr/bin/open -a Safari");
    // Written only once Safari is out — a running Safari overwrites a pref with its cached value on quit.
    expect(quit).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(quit);
    expect(open).toBeGreaterThan(write);
  });
  it("writes without quitting or relaunching when Safari is not running", async () => {
    const { run, calls } = fake({ "/usr/bin/pgrep -x": { exitCode: 1 } });
    expect(await enableSafariJavaScript(run)).toEqual({ relaunched: false });
    expect(calls.some((c) => c[0] === "/usr/bin/osascript")).toBe(false);
    expect(calls.some((c) => c[0] === "/usr/bin/open")).toBe(false);
    expect(calls.filter((c) => c[1] === "write")).toHaveLength(1);
  });
  it("fails loudly, naming Full Disk Access, when the write is refused", async () => {
    const { run } = fake({ "/usr/bin/pgrep -x": { exitCode: 1 }, "/usr/bin/defaults write": { exitCode: 1, stderr: "Could not write domain" } });
    await expect(enableSafariJavaScript(run)).rejects.toThrow(/Full Disk Access/);
  });
  it("still relaunches a running Safari when the write fails, and the error names Full Disk Access", async () => {
    const { run, calls } = fake({
      "/usr/bin/defaults write": { exitCode: 1, stderr: "Could not write domain" },
    });
    await expect(enableSafariJavaScript(quittingSafari(run))).rejects.toThrow(/Full Disk Access/);
    expect(calls.some((c) => c.join(" ") === "/usr/bin/open -a Safari")).toBe(true);
  });
  it("names the relaunch, not the write, when the write succeeds but the reopen fails", async () => {
    const { run } = fake({ "/usr/bin/open -a": { exitCode: 1 } });
    await expect(enableSafariJavaScript(quittingSafari(run))).rejects.toThrow(/did not relaunch/);
  });
  it("rejects at once when Safari cannot be asked to quit, and never attempts the write", async () => {
    const { run, calls } = fake({
      "/usr/bin/pgrep -x": { stdout: "123\n" },
      "/usr/bin/osascript -e": { exitCode: 1 },
    });
    await expect(enableSafariJavaScript(run)).rejects.toThrow(/could not be asked to quit/);
    expect(calls.some((c) => c[1] === "write")).toBe(false);
  });
});
