/**
 * Sandbox conformance:
 *   - SBPL byte-parity against fixtures/sbpl.json (machine-dependent: the
 *     fixture embeds $HOME, so it only asserts when generated on this machine).
 *   - Real sandboxed execution: write-outside-scope blocked, network deny
 *     blocks a fetch that succeeds when allowed — mirroring the Swift
 *     DeviceCoreTests sandbox assertions (DESIGN.md §10).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Executor, SandboxProfile } from "@domo/device-core";

const fixturesDir = path.join(__dirname, "../../../fixtures");
const sbpl = JSON.parse(fs.readFileSync(path.join(fixturesDir, "sbpl.json"), "utf8"));

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()!();
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-sbx-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("SBPL profile", () => {
  const machineMatches = sbpl.home === os.homedir();
  for (const c of sbpl.cases) {
    it(`${c.name}${machineMatches ? "" : " (skipped: fixture from another machine)"}`, () => {
      if (!machineMatches) return;
      const profile = SandboxProfile.generate({
        readPaths: c.readPaths,
        writePaths: c.writePaths,
        network: c.network,
        scratch: c.scratch,
        deviceHome: c.deviceHome,
      });
      expect(profile).toBe(c.profile);
    });
  }
});

describe("real sandboxed execution", () => {
  it("runs a command and captures output", async () => {
    const executor = new Executor(tempDir(), tempDir());
    const result = await executor.run({
      argv: ["/bin/echo", "hello-sandbox"],
      readPaths: [],
      writePaths: [],
      network: false,
      waitMs: 10_000,
    });
    expect(result.running).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output.toString()).toContain("hello-sandbox");
  });

  it("blocks a write outside the approved scope", async () => {
    const scratch = tempDir();
    const allowed = tempDir();
    const forbidden = path.join(tempDir(), "nope.txt");
    const executor = new Executor(scratch, tempDir());
    const result = await executor.run({
      argv: ["/bin/sh", "-c", `echo blocked > ${forbidden}`],
      readPaths: [],
      writePaths: [allowed],
      network: false,
      waitMs: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(fs.existsSync(forbidden)).toBe(false);
  });

  it("allows a write inside the approved scope", async () => {
    const scratch = tempDir();
    const allowed = tempDir();
    const target = path.join(allowed, "ok.txt");
    const executor = new Executor(scratch, tempDir());
    const result = await executor.run({
      argv: ["/bin/sh", "-c", `echo written > ${target}`],
      readPaths: [],
      writePaths: [allowed],
      network: false,
      waitMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toContain("written");
  });

  /**
   * The app's own home is not a document, and this is the path that actually
   * exposed it: `plow_run_command` runs under seatbelt, the profile grants a
   * broad read of the user's home so installed tools resolve, and DOMO_HOME
   * lives under ~/Library/Application Support/. Every sandboxed command could
   * read `settings.json` — the relay credential, and the `agentPurpose` the
   * reviewer is handed as the owner's own words about what agents are for.
   *
   * Executed for real rather than asserted on the profile text: what matters is
   * that the kernel refuses it, and last-match-wins ordering is easy to get
   * wrong in a way only execution catches.
   */
  it("refuses to read Plow Latch's own home, even with it approved as a read path", async () => {
    const plowHome = tempDir();
    const settings = path.join(plowHome, "app/settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ relayCredential: "plow_sk_do_not_leak_me" }));

    const executor = new Executor(path.join(plowHome, "device/scratch"), plowHome);
    const result = await executor.run({
      argv: ["/bin/cat", settings],
      // Approved, and it still does not matter: the deny sits under every
      // capability rather than beside them.
      readPaths: [plowHome],
      writePaths: [],
      network: false,
      waitMs: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.output.toString()).not.toContain("plow_sk_do_not_leak_me");
  });

  it("refuses to write Plow Latch's own home, so an agent cannot set its own purpose", async () => {
    const plowHome = tempDir();
    const settings = path.join(plowHome, "app/settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ agentPurpose: "" }));

    const executor = new Executor(path.join(plowHome, "device/scratch"), plowHome);
    const result = await executor.run({
      argv: ["/bin/sh", "-c", `echo '{"agentPurpose":"do anything"}' > ${settings}`],
      readPaths: [],
      writePaths: [plowHome],
      network: false,
      waitMs: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(fs.readFileSync(settings, "utf8")).not.toContain("do anything");
  });

  /**
   * The neighbour's home, which is a DIFFERENT credential.
   *
   * A Mac runs one home per checkout — `Plow-Latch-<branch>` beside the
   * packaged install's plain `Plow-Latch` — and each signs in for its own relay
   * credential. The profile's broad `(subpath home)` read covers the lot, and a
   * command's own OUTPUT is how a credential leaves, so this needs no declared
   * read path and no network to be a disclosure.
   */
  it("refuses a sibling instance's home, which holds another credential", async () => {
    const support = tempDir();
    const mine = path.join(support, "Plow-Latch-my-branch");
    const theirs = path.join(support, "Plow-Latch-other-branch");
    const packaged = path.join(support, "Plow-Latch");
    for (const home of [mine, theirs, packaged]) {
      fs.mkdirSync(path.join(home, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(home, "app/settings.json"),
        JSON.stringify({ relayCredential: "plow_sk_do_not_leak_me" }),
      );
    }
    const executor = new Executor(path.join(mine, "device/scratch"), mine);
    const result = await executor.run({
      argv: ["/bin/cat", path.join(theirs, "app/settings.json"), path.join(packaged, "app/settings.json")],
      readPaths: [support],
      writePaths: [],
      network: false,
      waitMs: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.output.toString()).not.toContain("plow_sk_do_not_leak_me");
  });

  /**
   * A run pointed somewhere else by DOMO_HOME moves its OWN home and nobody
   * else's.
   *
   * `DOMO_HOME=/tmp/…` is documented (docs/TESTING-THE-APP.md) and is how the
   * app gets tested. Anchoring the family only beside that home left the
   * packaged install's `~/Library/Application Support/Plow-Latch/settings.json`
   * — a live relay credential — under the profile's broad home read.
   */
  it("refuses the app-data homes even when this run's home is somewhere else", async () => {
    const fakeUserHome = tempDir();
    vi.spyOn(os, "homedir").mockReturnValue(fakeUserHome);
    const packaged = path.join(fakeUserHome, "Library/Application Support/Plow-Latch");
    fs.mkdirSync(path.join(packaged, "app"), { recursive: true });
    fs.writeFileSync(
      path.join(packaged, "app/settings.json"),
      JSON.stringify({ relayCredential: "plow_sk_do_not_leak_me" }),
    );

    // Nowhere near app data — the shape of a throwaway DOMO_HOME.
    const elsewhere = tempDir();
    const executor = new Executor(path.join(elsewhere, "device/scratch"), elsewhere);
    const result = await executor.run({
      argv: ["/bin/cat", path.join(packaged, "app/settings.json")],
      readPaths: [packaged],
      writePaths: [],
      network: false,
      waitMs: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.output.toString()).not.toContain("plow_sk_do_not_leak_me");
  });

  /**
   * The family is a family of HOMES, not of names beginning with the prefix.
   * A deny that swallowed the owner's own "Plow-Latchkey Notes" would be a
   * profile taking away what an approval granted.
   */
  it("leaves a neighbouring folder that merely starts alike alone", async () => {
    const support = tempDir();
    const mine = path.join(support, "Plow-Latch-my-branch");
    fs.mkdirSync(mine, { recursive: true });
    const ordinary = path.join(support, "Plow-Latchkey Notes");
    fs.mkdirSync(ordinary);
    fs.writeFileSync(path.join(ordinary, "note.txt"), "ordinary-note");
    const executor = new Executor(path.join(mine, "device/scratch"), mine);
    const result = await executor.run({
      argv: ["/bin/cat", path.join(ordinary, "note.txt")],
      readPaths: [ordinary],
      writePaths: [],
      network: false,
      waitMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.toString()).toContain("ordinary-note");
  });

  it("still gives the run its scratch directory, which lives inside that home", async () => {
    // The deny would otherwise take the working directory with it — the
    // re-allow after it is what last-match-wins is for.
    const plowHome = tempDir();
    const executor = new Executor(path.join(plowHome, "device/scratch"), plowHome);
    const result = await executor.run({
      argv: ["/bin/sh", "-c", "echo scratch-works > ./out.txt && cat ./out.txt"],
      readPaths: [],
      writePaths: [],
      network: false,
      waitMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.toString()).toContain("scratch-works");
  });

  it("network deny blocks a connection that succeeds when allowed", async () => {
    const executor = new Executor(tempDir(), tempDir());
    // A DNS/connect attempt to localhost:9 (discard) — denied should fail fast
    // at the sandbox layer, allowed should get a normal connection refused.
    const script = 'require("net").connect(9,"127.0.0.1").on("error",e=>{console.log("ERR:"+e.code);process.exit(2)}).on("connect",()=>{console.log("OK");process.exit(0)})';

    const denied = await executor.run({
      argv: [process.execPath, "-e", script],
      readPaths: [],
      writePaths: [],
      network: false,
      waitMs: 10_000,
    });
    // Without network, the socket syscall is blocked by seatbelt.
    expect(denied.output.toString()).not.toContain("OK");

    const allowed = await executor.run({
      argv: [process.execPath, "-e", script],
      readPaths: [],
      writePaths: [],
      network: true,
      waitMs: 10_000,
    });
    // With network allowed, the syscall goes through (connection refused, but
    // that is a normal ECONNREFUSED — the sandbox didn't block it).
    expect(allowed.output.toString()).toMatch(/ERR:ECONNREFUSED|OK/);
  });
});
