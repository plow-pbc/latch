/**
 * In-process file operations, bounds-checked against the approved capability
 * paths — twin of DomoDeviceCore/FileOps.swift. Trusted code, which is
 * exactly why every access is canonicalized and scope-checked (symlinks and
 * ".." resolved) before touching the disk.
 */
import fs from "node:fs";
import path from "node:path";
import { canonicalize, isWithinRoots } from "@domo/protocol";

export class FileOpsError extends Error {
  constructor(
    message: string,
    public readonly outOfBounds = false,
  ) {
    super(message);
    this.name = "FileOpsError";
  }
}

export const FileOps = {
  read(filePath: string, allowedRoots: string[]): Buffer {
    const canonical = canonicalize(filePath);
    if (!isWithinRoots(canonical, allowedRoots)) {
      throw new FileOpsError(`path outside approved scope: ${filePath}`, true);
    }
    try {
      return fs.readFileSync(canonical);
    } catch (error: unknown) {
      throw new FileOpsError(`read failed: ${error instanceof Error ? error.message : error}`);
    }
  },

  write(filePath: string, data: Buffer, allowedRoots: string[]): void {
    const canonical = canonicalize(filePath);
    if (!isWithinRoots(canonical, allowedRoots)) {
      throw new FileOpsError(`path outside approved scope: ${filePath}`, true);
    }
    try {
      fs.mkdirSync(path.dirname(canonical), { recursive: true });
      fs.writeFileSync(canonical, data);
    } catch (error: unknown) {
      throw new FileOpsError(`write failed: ${error instanceof Error ? error.message : error}`);
    }
  },
};
