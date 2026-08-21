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
 * then proved to be the checked file two ways:
 *
 * - `O_NOFOLLOW` refuses a symlink at the leaf outright, so only an
 *   intermediate directory is left to swap.
 * - Resolving the name again must give back the same canonical path (a swap
 *   that is still in place resolves somewhere else — into DOMO_HOME, which is
 *   the point of the attack), and the descriptor's own device/inode must match
 *   the name's (a swap that has been reverted leaves the name innocent but the
 *   descriptor on the attacker's file).
 *
 * Either check failing is a refusal, not a retry: something moved under a path
 * an approval had already been granted for, and re-running the race is not an
 * answer to having lost it.
 */
async function openVerified(
  canonical: string,
  flags: number,
): Promise<{ handle: FileHandle; stat: Stats }> {
  const handle = await fs.open(canonical, flags | fsConstants.O_NOFOLLOW);
  try {
    const [opened, name, resolved] = await Promise.all([
      handle.stat(),
      fs.lstat(canonical),
      canonicalizeAsync(canonical),
    ]);
    if (resolved !== canonical || opened.dev !== name.dev || opened.ino !== name.ino) {
      throw new FileOpsError(
        "the path changed underneath this operation and was not the file that was approved",
        true,
      );
    }
    // The descriptor's own stat, so size and type are read off the thing that
    // was just proved rather than off the name a second time.
    return { handle, stat: opened };
  } catch (error: unknown) {
    await handle.close().catch(() => {});
    throw error;
  }
}


/**
 * Open one directory and prove it is the directory the canonical path names —
 * or report that it is not there yet.
 *
 * `null` means ENOENT and nothing else: any other refusal throws, because a
 * component that has become a symlink (`ELOOP`, from `O_NOFOLLOW`) is the
 * attack and not an absence to be filled in.
 */
async function openDirVerified(dir: string): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(
      dir,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException)?.code === "ELOOP") {
      throw new FileOpsError(
        `a directory on the way to this path is a symlink, which is not what was approved: ${dir}`,
        true,
      );
    }
    throw error;
  }
  try {
    const [opened, name, resolved] = await Promise.all([
      handle.stat(),
      fs.lstat(dir),
      canonicalizeAsync(dir),
    ]);
    if (resolved !== dir || opened.dev !== name.dev || opened.ino !== name.ino) {
      throw new FileOpsError(
        `the path changed underneath this operation and was not the directory that was approved: ${dir}`,
        true,
      );
    }
    return handle;
  } catch (error: unknown) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/**
 * Walk down to the file's parent, verifying every component and creating only
 * what is missing — one level at a time, each one proved before the next.
 *
 * `mkdir(…, {recursive: true})` was the hole: it resolves the whole path itself
 * and creates as it goes, so a directory swapped for a symlink mid-walk left
 * real directories — and then an `O_CREAT` zero-length file — somewhere nobody
 * approved, including inside Plow Latch's own home. The refusal that followed
 * was already too late.
 *
 * Node has no `openat`/`mkdirat`, so this cannot be made atomic; what it can be
 * is ORDERED. Nothing is created until its parent has been opened and proved,
 * each new directory is proved immediately after it appears, the scope and home
 * checks are re-run at every level rather than once at the bottom, and anything
 * this call created is removed again if a later level refuses. A swap can
 * therefore still lose us a step — it cannot leave the step behind.
 */
async function prepareParent(
  canonical: string,
  allowedRoots: string[],
  deviceHome: string,
): Promise<void> {
  const created: string[] = [];
  let current = "";
  try {
    for (const component of path.dirname(canonical).split("/").filter(Boolean)) {
      current = current + "/" + component;
      let handle = await openDirVerified(current);
      if (handle === null) {
        // Creating, so the checks come first and at THIS level: an approval
        // covers a directory the operation is under, never one above it.
        const home = await canonicalizeAsync(deviceHome);
        if (isInsidePlowHome(current, home)) {
          throw new FileOpsError(
            "path is inside Plow Latch's own home directory, which agents may not read or write",
            true,
          );
        }
        if (!(await isWithinRootsAsync(current, allowedRoots))) {
          throw new FileOpsError(`path outside approved scope: ${current}`, true);
        }
        await fs.mkdir(current);
        created.push(current);
        handle = await openDirVerified(current);
        if (handle === null) throw new FileOpsError(`could not create directory: ${current}`);
      }
      await handle.close().catch(() => {});
    }
  } catch (error: unknown) {
    // Ours to remove, and only ours: deepest first, only while the name still
    // resolves to itself, and `rmdir` refuses anything somebody has since put
    // something in. Cleaning up must never become its own way of deleting
    // something: if the swap that caused the refusal is still in place, this
    // does nothing at all rather than remove whatever is at the other end.
    for (const dir of created.reverse()) {
      if ((await canonicalizeAsync(dir).catch(() => "")) !== dir) continue;
      await fs.rmdir(dir).catch(() => {});
    }
    throw error;
  }
}

/** See the call site: the narrowest possible unwind of a file we just created. */
async function removeIfOursAndEmpty(canonical: string): Promise<void> {
  if ((await canonicalizeAsync(canonical).catch(() => "")) !== canonical) return;
  const info = await fs.lstat(canonical).catch(() => null);
  if (info === null || !info.isFile() || info.size !== 0) return;
  await fs.unlink(canonical).catch(() => {});
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
    await prepareParent(canonical, allowedRoots, deviceHome);
    // Whether the file was already there decides what a refusal has to clean
    // up: one we created is ours to remove, one that existed is not.
    const existed = await fs.lstat(canonical).then(
      () => true,
      () => false,
    );
    let handle: FileHandle;
    try {
      // Created if absent, never TRUNCATED here: truncation is destruction, and
      // it must not happen until the descriptor has been proved to be the file
      // that was checked. An open that emptied the wrong file and then refused
      // would have done the damage the refusal is for.
      handle = (await openVerified(canonical, fsConstants.O_WRONLY | fsConstants.O_CREAT)).handle;
    } catch (error: unknown) {
      // Only a file this call created, only while the name still resolves to
      // itself, and only while it is still empty. A refusal must not turn into
      // a delete of whatever the redirect pointed at — leaving a stray empty
      // file is the lesser failure by a wide margin.
      if (!existed) await removeIfOursAndEmpty(canonical);
      if (error instanceof FileOpsError) throw error;
      throw new FileOpsError(`write failed: ${error instanceof Error ? error.message : error}`);
    }
    try {
      await handle.truncate(0);
      await handle.write(data, 0, data.length, 0);
    } catch (error: unknown) {
      throw new FileOpsError(`write failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      await handle.close().catch(() => {});
    }
  },
};
