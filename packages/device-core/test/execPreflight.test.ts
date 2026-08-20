/**
 * What the sandbox will refuse to execute, decided before anyone is asked to
 * approve it. The rule that motivates all of this: seatbelt will not exec a
 * setuid or setgid binary, whatever the profile allows, so `/bin/ps` was
 * approved by the owner and then killed by the kernel.
 *
 * The other half of the contract is that this must not refuse anything the
 * sandbox would have run, which is why the resolution rules are pinned here
 * command by command.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execRefusal, sandboxPath } from "@domo/device-core";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-exec-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A file on disk with exactly the mode asked for. */
function file(dir: string, name: string, mode: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(p, mode);
  return p;
}

/** A fake home whose `bin` is on the PATH commands run with. */
function homeWith(name: string, mode: number): { home: string; path: string } {
  const home = tempDir();
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  return { home, path: file(bin, name, mode) };
}

describe("a command the sandbox cannot execute is refused before approval", () => {
  it("refuses a setuid binary, naming the bit and the sandbox", async () => {
    const dir = tempDir();
    const suid = file(dir, "suid-tool", 0o4755);
    // The bit is what the test is about; if the filesystem dropped it there is
    // nothing here to assert.
    expect(fs.statSync(suid).mode & 0o4000).toBe(0o4000);

    const refusal = await execRefusal([suid]);
    expect(refusal).toMatch(/setuid/);
    expect(refusal).toMatch(/sandbox/);
    expect(refusal).toContain(suid);
  });

  it("refuses a setgid binary too", async () => {
    const dir = tempDir();
    const sgid = file(dir, "sgid-tool", 0o2755);
    expect(fs.statSync(sgid).mode & 0o2000).toBe(0o2000);

    expect(await execRefusal([sgid])).toMatch(/setgid/);
  });

  it("refuses /bin/ps — the command the owner approved and the kernel killed", async () => {
    // The incident's exact argv. macOS ships ps setuid root; assert that first
    // so a change in the OS reads as a changed premise, not a broken test.
    expect(fs.statSync("/bin/ps").mode & 0o4000).toBe(0o4000);

    const refusal = await execRefusal(["/bin/ps", "-ax", "-o", "pid,lstart,command"]);
    expect(refusal).toMatch(/setuid/);
    expect(refusal).toMatch(/Nothing was approved/);
  });

  it("refuses a name that is on no PATH directory", async () => {
    expect(await execRefusal(["definitely-not-a-real-command-9f2a"])).toMatch(/not found on the PATH/);
  });

  it("refuses an absolute path that is not there", async () => {
    expect(await execRefusal([path.join(tempDir(), "absent")])).toMatch(/is not on this Mac/);
  });

  it("refuses a file that is not executable", async () => {
    const notExec = file(tempDir(), "data.txt", 0o644);
    expect(await execRefusal([notExec])).toMatch(/not an executable file/);
  });

  it("refuses an empty argv", async () => {
    expect(await execRefusal([])).toMatch(/no command/);
    expect(await execRefusal([""])).toMatch(/no command/);
  });
});

describe("what the sandbox can run is not refused", () => {
  it("allows an ordinary system binary", async () => {
    expect(await execRefusal(["/bin/echo", "hello"])).toBeNull();
  });

  it("allows a bare name found on the PATH", async () => {
    expect(await execRefusal(["echo"])).toBeNull();
    expect(await execRefusal(["sh", "-c", "true"])).toBeNull();
  });

  it("allows a relative name inside the approved cwd", async () => {
    const dir = tempDir();
    file(dir, "tool.sh", 0o755);
    expect(await execRefusal(["./tool.sh"], { cwd: dir })).toBeNull();
  });

  it("allows a symlink to an ordinary binary, since exec follows it", async () => {
    const dir = tempDir();
    const link = path.join(dir, "echo-link");
    fs.symlinkSync("/bin/echo", link);
    expect(await execRefusal([link])).toBeNull();
  });

  it("refuses a symlink to a setuid binary, for the same reason", async () => {
    const dir = tempDir();
    const link = path.join(dir, "ps-link");
    fs.symlinkSync("/bin/ps", link);
    expect(await execRefusal([link])).toMatch(/setuid/);
  });
});

describe("the search matches the PATH the child is given", () => {
  it("resolves a bare name against the home directories on that PATH", async () => {
    const { home, path: tool } = homeWith("home-tool", 0o755);
    expect(sandboxPath(home)).toContain(path.dirname(tool));
    expect(await execRefusal(["home-tool"], { home })).toBeNull();
  });

  it("takes the first executable match in PATH order, as execvp does", async () => {
    const { home } = homeWith("dupe", 0o4755); // ~/bin/dupe, setuid
    const local = path.join(home, ".local", "bin");
    fs.mkdirSync(local, { recursive: true });
    file(local, "dupe", 0o755); // ~/.local/bin/dupe, ordinary — searched first

    expect(sandboxPath(home).indexOf(local)).toBeLessThan(sandboxPath(home).indexOf(path.join(home, "bin")));
    expect(await execRefusal(["dupe"], { home })).toBeNull();
  });

  it("keeps searching past a match that cannot be executed", async () => {
    const home = tempDir();
    const local = path.join(home, ".local", "bin");
    const bin = path.join(home, "bin");
    fs.mkdirSync(local, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    file(local, "later", 0o644); // exists, not executable — execvp moves on
    file(bin, "later", 0o755);

    expect(await execRefusal(["later"], { home })).toBeNull();
  });

  it("resolves a relative name to nothing when no cwd was approved", async () => {
    // The executor runs such a command in a scratch directory it creates empty,
    // so 'that file next to me' is never there.
    const dir = tempDir();
    file(dir, "tool.sh", 0o755);
    expect(await execRefusal(["./tool.sh"])).toMatch(/is not on this Mac/);
  });
});
