/**
 * Check-then-open, driven rather than described.
 *
 * `FileOps` resolves a path, checks it, and then opens it — two trips to the
 * filesystem with a window between them. A directory in the path becoming a
 * symlink inside that window is the whole attack: the check passes on an
 * approved file and the open lands on `settings.json`, which holds the relay
 * credential and the `agentPurpose` the reviewer reads as the owner's own
 * words.
 *
 * A wall-clock race proves nothing here — it passed against the unfixed code
 * simply by never landing in a window microseconds wide. So the window is
 * OPENED deterministically: the swap is performed from inside the first
 * filesystem call `FileOps` makes after its checks are done. That is the exact
 * moment a real attacker needs, and it is now every run rather than one in
 * millions.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Fires once, from inside the first post-check filesystem call. */
let swap: (() => void) | null = null;

function armed<T extends unknown[], R>(
  call: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  return async (...args: T) => {
    if (swap !== null && typeof args[0] === "string" && args[0].includes("swapme")) {
      const fire = swap;
      swap = null;
      fire();
    }
    return call(...args);
  };
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs/promises");
  // Every entry point a read or a write reaches AFTER its path has been
  // resolved and approved. Whichever comes first is the window.
  const patched = {
    ...actual,
    open: armed(actual.open),
    stat: armed(actual.stat),
    mkdir: armed(actual.mkdir),
    lstat: armed(actual.lstat),
    readFile: armed(actual.readFile),
    writeFile: armed(actual.writeFile),
  };
  return { ...patched, default: patched };
});

const { FileOps } = await import("@domo/device-core");

const cleanups: (() => void)[] = [];
afterEach(() => {
  swap = null;
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-race-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SECRET = "plow_sk_do_not_leak_me";

/**
 * An approved directory holding an ordinary file, and the swap that replaces
 * that DIRECTORY with a symlink into the app's own home.
 *
 * A directory, not a symlink already in the path: `canonicalize` returns a
 * physical path, so a symlink present at check time is resolved away and can
 * redirect nothing afterwards. The component has to be a real directory when
 * the check runs and a symlink when the open does — which is a rename and a
 * symlink, two calls an attacker with a write anywhere in the tree can make.
 */
function stage(): {
  target: string;
  approved: string;
  plowHome: string;
  settings: string;
  dir: string;
} {
  const plowHome = tempDir();
  fs.mkdirSync(path.join(plowHome, "app"), { recursive: true });
  const settings = path.join(plowHome, "app/settings.json");
  fs.writeFileSync(settings, SECRET);

  const approved = tempDir();
  const dir = path.join(approved, "swapme");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "settings.json"), "ordinary");

  swap = () => {
    fs.renameSync(dir, dir + ".moved");
    fs.symlinkSync(path.join(plowHome, "app"), dir);
  };
  return { target: path.join(dir, "settings.json"), approved, plowHome, settings, dir };
}

describe("a path that changes between the check and the open", () => {
  it("is refused rather than read", async () => {
    const { target, approved, plowHome } = stage();
    await expect(FileOps.read(target, [approved], plowHome)).rejects.toThrow();
    // Belt and braces: whatever the refusal says, the credential is not in it.
    await FileOps.read(target, [approved], plowHome).then(
      (buf) => expect(buf.toString()).not.toContain(SECRET),
      () => {},
    );
  });

  /**
   * The same window, with nothing at the destination yet — and with the roots
   * `plow_write_file` actually grants: `[target]`, the file itself.
   *
   * This is what `mkdir(…, {recursive: true})` lost. It resolved the whole path
   * itself and created as it went, so a swap mid-walk left real directories —
   * and then a zero-length file — inside Plow Latch's own home, with the
   * refusal arriving afterwards. Nothing creates a directory here now, at any
   * depth, so there is no walk left to redirect.
   *
   * The residual is stated rather than hidden: Node has no `openat`, so a
   * parent swapped between its proof and the leaf's open can still take the
   * `O_EXCL` create with it. What that can leave is an EMPTY file with a name
   * the agent chose. It cannot land on an existing file, no bytes are written,
   * and the operation refuses — and this asserts each of those.
   */
  it("creates no directory, writes no byte, and touches nothing that already exists", async () => {
    const { approved, plowHome, settings, dir } = stage();
    const target = path.join(dir, "absent.txt");
    await expect(
      FileOps.write(target, Buffer.from("agent wrote this"), [target], plowHome),
    ).rejects.toThrow();

    const home = path.join(plowHome, "app");
    for (const entry of fs.readdirSync(home)) {
      const info = fs.lstatSync(path.join(home, entry));
      // No directory of ours, and nothing carrying content.
      expect(info.isDirectory()).toBe(false);
      if (entry !== "settings.json") expect(info.size).toBe(0);
    }
    expect(fs.readFileSync(settings, "utf8")).toBe(SECRET);
    expect(fs.existsSync(path.join(approved, "absent.txt"))).toBe(false);
  });

  it("refuses a directory it would have had to build, and builds none", async () => {
    const { approved, plowHome, dir } = stage();
    const target = path.join(dir, "new/deeper/written.txt");
    await expect(
      FileOps.write(target, Buffer.from("agent wrote this"), [target], plowHome),
    ).rejects.toThrow(/does not exist/);
    expect(fs.readdirSync(path.join(plowHome, "app")).sort()).toEqual(["settings.json"]);
    expect(fs.existsSync(path.join(dir + ".moved", "new"))).toBe(false);
    expect(fs.existsSync(path.join(approved, "new"))).toBe(false);
  });

  it("is refused rather than written, and nothing is truncated on the way", async () => {
    const { target, approved, plowHome, settings } = stage();
    await expect(
      FileOps.write(target, Buffer.from("agent wrote this"), [approved], plowHome),
    ).rejects.toThrow();
    // The file is neither overwritten nor emptied: an open that truncates
    // before it verifies has already done the damage.
    expect(fs.readFileSync(settings, "utf8")).toBe(SECRET);
  });
});
