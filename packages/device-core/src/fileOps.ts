/**
 * In-process file operations, bounds-checked against the approved capability
 * paths — twin of DomoDeviceCore/FileOps.swift. Trusted code, which is
 * exactly why every access is canonicalized and scope-checked (symlinks and
 * ".." resolved) before touching the disk.
 *
 * These are **async and size-capped** because a tunnelled call has a hard time
 * budget. Synchronous reads block the event loop, so a large file or a slow
 * mounted volume would stop the budget timer from ever firing: the caller would
 * return late, after the relay had already told the agent the call failed, while
 * this Mac went ahead and did the work anyway.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalizeAsync, isWithinRootsAsync } from "@domo/protocol";

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
async function resolveInScope(filePath: string, allowedRoots: string[]): Promise<string> {
  const canonical = await canonicalizeAsync(filePath);
  if (!(await isWithinRootsAsync(canonical, allowedRoots))) {
    throw new FileOpsError(`path outside approved scope: ${filePath}`, true);
  }
  return canonical;
}

export const FileOps = {
  async read(filePath: string, allowedRoots: string[]): Promise<Buffer> {
    const canonical = await resolveInScope(filePath, allowedRoots);
    let size: number;
    try {
      const info = await fs.stat(canonical);
      if (info.isDirectory()) throw new FileOpsError(`not a file: ${canonical}`);
      size = info.size;
    } catch (error: unknown) {
      if (error instanceof FileOpsError) throw error;
      throw new FileOpsError(`read failed: ${error instanceof Error ? error.message : error}`);
    }
    if (size > MAX_FILE_BYTES) {
      throw new FileOpsError(
        `file is ${size} bytes, over the ${MAX_FILE_BYTES}-byte single-call limit`,
      );
    }
    try {
      return await fs.readFile(canonical);
    } catch (error: unknown) {
      throw new FileOpsError(`read failed: ${error instanceof Error ? error.message : error}`);
    }
  },

  async write(filePath: string, data: Buffer, allowedRoots: string[]): Promise<void> {
    if (data.length > MAX_FILE_BYTES) {
      throw new FileOpsError(
        `content is ${data.length} bytes, over the ${MAX_FILE_BYTES}-byte single-call limit`,
      );
    }
    const canonical = await resolveInScope(filePath, allowedRoots);
    try {
      await fs.mkdir(path.dirname(canonical), { recursive: true });
      await fs.writeFile(canonical, data);
    } catch (error: unknown) {
      throw new FileOpsError(`write failed: ${error instanceof Error ? error.message : error}`);
    }
  },
};
