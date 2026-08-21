/**
 * A file is written whole or not at all.
 *
 * Two ways it was not. `write(2)` returns how much it took, and one call is not
 * a promise to take the buffer — a short write was reported to the agent as a
 * completed write of the whole file. And two tunnelled calls naming the same
 * file ran concurrently, each truncating before it wrote, so one's truncate
 * could land between the other's write and its own and leave the file holding a
 * piece of each — with both calls reporting success.
 *
 * Neither is reachable by waiting for a slow disk, so the short write is made
 * to happen: every `write` here takes a bounded bite and yields, which is what a
 * real partial write does and what makes the interleaving deterministic.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Largest bite any single write is allowed to take. 0 = unlimited. */
let biteSize = 0;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs/promises");
  const open = async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const write = handle.write.bind(handle);
    return new Proxy(handle, {
      get(target, prop, receiver) {
        if (prop !== "write" || biteSize === 0) return Reflect.get(target, prop, receiver);
        return async (buffer: Buffer, offset: number, length: number, position: number) => {
          // Yield first: this is where a second call gets its turn, and where
          // an unserialized truncate used to land mid-write.
          await new Promise((r) => setImmediate(r));
          return write(buffer, offset, Math.min(length, biteSize), position);
        };
      },
    });
  };
  return { ...actual, default: { ...actual, open }, open };
});

const { FileOps } = await import("@domo/device-core");

const cleanups: (() => void)[] = [];
afterEach(() => {
  biteSize = 0;
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-fswrite-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const DEVICE_HOME = "/domo-nonexistent-device-home";

describe("a write that the disk takes in pieces", () => {
  it("writes every byte rather than reporting the first chunk as the whole file", async () => {
    const dir = tempDir();
    const target = path.join(dir, "out.txt");
    fs.writeFileSync(target, "");
    const content = "x".repeat(5000);
    biteSize = 512;

    await FileOps.write(target, Buffer.from(content), [target], DEVICE_HOME);
    expect(fs.readFileSync(target, "utf8")).toBe(content);
  });
});

describe("two calls naming the same file", () => {
  it("leave one of them whole, never a piece of each", async () => {
    const dir = tempDir();
    const target = path.join(dir, "out.txt");
    fs.writeFileSync(target, "");
    // Different bytes AND different lengths: a shorter write landing inside a
    // longer one leaves a tail, which is the mixture this must not produce.
    const bodies = ["a".repeat(4000), "b".repeat(1200), "c".repeat(3000), "d".repeat(700)];
    biteSize = 256;

    await Promise.all(
      bodies.map((body) => FileOps.write(target, Buffer.from(body), [target], DEVICE_HOME)),
    );

    const written = fs.readFileSync(target, "utf8");
    expect(bodies).toContain(written);
  });

  it("does not let one call's failure cancel the call queued behind it", async () => {
    const dir = tempDir();
    const target = path.join(dir, "out.txt");
    fs.writeFileSync(target, "");
    biteSize = 256;

    const [failed, ok] = await Promise.allSettled([
      // Refused for being outside the approved scope, after it has taken its
      // place in the queue for this path.
      FileOps.write(target, Buffer.from("nope"), [path.join(dir, "elsewhere")], DEVICE_HOME),
      FileOps.write(target, Buffer.from("kept"), [target], DEVICE_HOME),
    ]);
    expect(failed.status).toBe("rejected");
    expect(ok.status).toBe("fulfilled");
    expect(fs.readFileSync(target, "utf8")).toBe("kept");
  });
});
