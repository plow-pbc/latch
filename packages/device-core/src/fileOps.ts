/**
 * In-process file operations, bounds-checked against the approved capability
 * paths — twin of DomoDeviceCore/FileOps.swift. Trusted code, which is
 * exactly why every access is canonicalized and scope-checked (symlinks and
 * ".." resolved), and then reads and writes the DESCRIPTOR it proved rather
 * than the name it checked — see `openVerified`.
 *
 * These are **async and size-capped** because a tunnelled call has a hard time
 * budget. Synchronous reads block the event loop, so a large file or a slow
 * mounted volume would stop the budget timer from ever firing: the caller would
 * return late, after the relay had already told the agent the call failed, while
 * this Mac went ahead and did the work anyway.
 */
import { constants as fsConstants, Stats } from "node:fs";
import fs, { FileHandle } from "node:fs/promises";
import path from "node:path";
import { canonicalizeAsync, isWithinRootsAsync } from "@domo/protocol";
import { isInsidePlowHome } from "./plowHome.js";

/**
 * Largest file these operations will read or write in one call.
 *
 * This is a call-budget bound, not a wire limit: base64 inflates by a third, so
 * this much file is ~11MB of JSON, and reading plus encoding it stays well
 * inside the budget on any reasonable disk. A bigger file is not refused
 * because it is dangerous — it is refused because a single tunnelled call is
 * the wrong shape for it.
 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * The app's own home is not a document.
 *
 * `settings.json` lives under DOMO_HOME and holds the relay credential — which
 * CLAUDE.md says leaves this Mac by exactly two routes and no third — and
 * `agentPurpose`, which the reviewer is handed as TRUSTED text describing what
 * the owner wants agents for. An agent that can write that file writes its own
 * permissions: one approved write, and every later review is judged against an
 * errand the agent composed for itself. The audit log and the rules file are
 * under there too.
 *
 * So this is refused mechanically, and refused for READS as well as writes: the
 * credential is in that file, and a read is how it would leave.
 *
 * This is not the enumerated-sensitive-paths list that DESIGN.md §5a declines.
 * That list was a reviewer being told to recognise other people's secrets by
 * name. This is one component refusing to let anything edit its own
 * configuration, it knows its own home for certain because it was handed it at
 * construction, and it holds whatever an approval said.
 */
export class FileOpsError extends Error {
  constructor(
    message: string,
    public readonly outOfBounds = false,
  ) {
    super(message);
    this.name = "FileOpsError";
  }
}

/**
 * Resolve and scope-check in one place. Callers pass a path that was ALREADY
 * canonicalized when the human approved it (see the MCP tool layer), so this
 * resolution is normally a no-op — it stays because this is trusted code and
 * must not depend on its caller having done the right thing.
 *
 * Async for the same reason the reads are: resolution is filesystem I/O, and a
 * synchronous one here would block the call budget's timer just as effectively
 * as a synchronous read would, only after the human had already approved.
 */
async function resolveInScope(
  filePath: string,
  allowedRoots: string[],
  deviceHome: string,
): Promise<string> {
  const canonical = await canonicalizeAsync(filePath);
  // BEFORE the scope check, deliberately: an approval that somehow named this
  // directory must not be the thing that authorizes it. There is no capability
  // set that makes the app's own state an agent's to touch.
  //
  // The FAMILY, not just this instance: one Mac runs a home per checkout, each
  // signed in for its own relay credential, so `Plow-Latch-<other>` beside this
  // one is somebody's credential too — and the packaged install's, in app data,
  // is somebody's whether or not this run was pointed at a home near it.
  const home = await canonicalizeAsync(deviceHome);
  if (isInsidePlowHome(canonical, home)) {
    throw new FileOpsError(
      "path is inside Plow Latch's own home directory, which agents may not read or write",
      true,
    );
  }
  if (!(await isWithinRootsAsync(canonical, allowedRoots))) {
    throw new FileOpsError(`path outside approved scope: ${filePath}`, true);
  }
  return canonical;
}

/**
 * The one test both openers rest on: is what this descriptor holds still what
 * this NAME says it is?
 *
 * Two questions, because a swap can be caught two ways. Re-resolving the name
 * catches one that is still in place — it lands somewhere else, typically
 * inside DOMO_HOME, which is the point of the attack. Comparing the
 * descriptor's device/inode against the name's catches one that has been put
 * back — the name looks innocent again while the descriptor is on the
 * attacker's file.
 */
async function provesToBe(handle: FileHandle, name: string): Promise<boolean> {
  const [opened, named, resolved] = await Promise.all([
    handle.stat(),
    fs.lstat(name),
    canonicalizeAsync(name),
  ]);
  return resolved === name && opened.dev === named.dev && opened.ino === named.ino;
}

const MOVED = "the path changed underneath this operation and was not what was approved";

/**
 * Open the checked path and prove the open landed on the thing that was
 * checked.
 *
 * Resolving a name and then opening it are two trips to the filesystem, and
 * between them a directory in the path can become a symlink: the check passes
 * on one file and the open lands on another. Nothing above this can close that
 * — the approval named a path, and a path is not a file.
 *
 * So the open comes first and every byte afterwards goes through the
 * DESCRIPTOR, which cannot be redirected once it exists, and the descriptor is
 * then proved to be the checked file: `O_NOFOLLOW` refuses a symlink at the
 * leaf outright, and `provesToBe` covers the rest.
 *
 * Failing is a refusal, not a retry: something moved under a path an approval
 * had already been granted for, and re-running the race is not an answer to
 * having lost it.
 */
async function openVerified(
  canonical: string,
  flags: number,
): Promise<{ handle: FileHandle; stat: Stats }> {
  const handle = await fs.open(canonical, flags | fsConstants.O_NOFOLLOW);
  try {
    if (!(await provesToBe(handle, canonical))) throw new FileOpsError(MOVED, true);
    // The descriptor's own stat, so size and type are read off the thing that
    // was just proved rather than off the name a second time.
    return { handle, stat: await handle.stat() };
  } catch (error: unknown) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/**
 * Open the directory a write is destined for, and prove it — or say it is not
 * there.
 *
 * `null` means ENOENT and nothing else: a component that has BECOME a symlink
 * (`ELOOP`, from `O_NOFOLLOW`) is the attack, not an absence to be filled in.
 */
async function openParent(dir: string): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(
      dir,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (code === "ELOOP") throw new FileOpsError(MOVED, true);
    throw error;
  }
  try {
    if (!(await provesToBe(handle, dir))) throw new FileOpsError(MOVED, true);
    return handle;
  } catch (error: unknown) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/**
 * Put the bytes in, with the proved parent held open the whole time.
 *
 * Open before create, and create with `O_EXCL`. Node has no `openat`, so the
 * leaf still has to be named — and a parent swapped in the instant between its
 * proof and that open would send the create elsewhere. `O_EXCL` is what makes
 * that survivable: a create can never land ON an existing file, so the worst a
 * lost race leaves is an empty file with a name the agent chose, in a directory
 * it already had to be able to swap. No content is written, nothing existing is
 * touched, and the operation refuses.
 *
 * Nothing tidies that file up. Removing it would mean deleting by the same
 * pathname that has just been shown to be untrustworthy — a refusal must not
 * become its own way of deleting somebody's file.
 *
 * The parent is re-proved after the leaf is open, which is what turns the lost
 * race into a refusal rather than a write.
 */
async function writeInto(
  parent: FileHandle,
  dir: string,
  canonical: string,
  data: Buffer,
): Promise<void> {
  let opened: { handle: FileHandle; stat: Stats };
  let created = false;
  try {
    // No O_CREAT and no O_TRUNC: truncation is destruction, and it must not
    // happen until the descriptor has been proved.
    opened = await openVerified(canonical, fsConstants.O_WRONLY);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    if (!(await provesToBe(parent, dir))) throw new FileOpsError(MOVED, true);
    opened = await openVerified(canonical, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL);
    created = true;
  }
  const { handle } = opened;
  try {
    if (!(await provesToBe(parent, dir))) throw new FileOpsError(MOVED, true);
    if (!created) await handle.truncate(0);
    await handle.write(data, 0, data.length, 0);
  } finally {
    await handle.close().catch(() => {});
  }
}

export const FileOps = {
  /**
   * `deviceHome` is REQUIRED, not optional with a default. A caller that forgot
   * it would be one whose file operations can reach the app's own settings, and
   * that must be a type error rather than a quiet hole.
   */
  async read(filePath: string, allowedRoots: string[], deviceHome: string): Promise<Buffer> {
    const canonical = await resolveInScope(filePath, allowedRoots, deviceHome);
    let opened: { handle: FileHandle; stat: Stats };
    try {
      opened = await openVerified(canonical, fsConstants.O_RDONLY);
    } catch (error: unknown) {
      if (error instanceof FileOpsError) throw error;
      throw new FileOpsError(`read failed: ${error instanceof Error ? error.message : error}`);
    }
    const { handle, stat } = opened;
    try {
      if (stat.isDirectory()) throw new FileOpsError(`not a file: ${canonical}`);
      if (stat.size > MAX_FILE_BYTES) {
        throw new FileOpsError(
          `file is ${stat.size} bytes, over the ${MAX_FILE_BYTES}-byte single-call limit`,
        );
      }
      return await handle.readFile();
    } catch (error: unknown) {
      if (error instanceof FileOpsError) throw error;
      throw new FileOpsError(`read failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      await handle.close().catch(() => {});
    }
  },

  /**
   * Writes the file an approval named. It does NOT build the path to it.
   *
   * A directory is not created here, at any depth, and an absent parent is
   * refused with a sentence the calling agent can act on. Two reasons, and
   * either would do on its own.
   *
   * The approval says `fs.write` on ONE file (see the MCP tool: `paths` is the
   * target and nothing else). The directories above it were never in the
   * capability set, so creating them was never covered — the old recursive
   * mkdir simply ran before any bound was consulted.
   *
   * And it cannot be made safe here. Every directory on the way would have to
   * be created through a descriptor for a swap not to redirect it, Node has no
   * `mkdirat`, and the pathname version left real directories — then a
   * zero-length file — somewhere nobody approved, with the refusal arriving
   * afterwards. An operation that cannot be done safely is better not offered.
   */
  async write(
    filePath: string,
    data: Buffer,
    allowedRoots: string[],
    deviceHome: string,
  ): Promise<void> {
    if (data.length > MAX_FILE_BYTES) {
      throw new FileOpsError(
        `content is ${data.length} bytes, over the ${MAX_FILE_BYTES}-byte single-call limit`,
      );
    }
    const canonical = await resolveInScope(filePath, allowedRoots, deviceHome);
    const dir = path.dirname(canonical);
    const parent = await openParent(dir);
    if (parent === null) {
      throw new FileOpsError(
        `the directory ${dir} does not exist. This operation writes a file; it does not ` +
          `create the directories on the way to one — create the directory first.`,
      );
    }
    try {
      await writeInto(parent, dir, canonical, data);
    } catch (error: unknown) {
      if (error instanceof FileOpsError) throw error;
      throw new FileOpsError(`write failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      await parent.close().catch(() => {});
    }
  },
};
