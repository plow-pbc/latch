/**
 * One durable, atomic file write, for the two files the vault cannot afford
 * to lose to a power cut: the key blob and the item store.
 *
 * A bare tmp-write + rename is atomic against a CRASH but not against power
 * loss — the kernel may persist the rename before the data, or persist one
 * file's rename and not its sibling's, in any order. Migration writes the
 * key and the items as two files whose ordering the recovery logic depends
 * on, so each write here is pushed to disk before it counts: fsync the temp
 * file, rename it into place, fsync the directory so the rename itself is
 * durable.
 */
import fs from "node:fs";
import path from "node:path";

export function writeFileDurable(file: string, data: Buffer | string, mode = 0o600): void {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  let dir: number | undefined;
  try {
    dir = fs.openSync(path.dirname(file), "r");
    fs.fsyncSync(dir);
  } catch {
    /* a directory that cannot be fsynced (odd filesystems) keeps the write */
  } finally {
    if (dir !== undefined) fs.closeSync(dir);
  }
}
