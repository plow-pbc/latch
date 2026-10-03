/**
 * The vault write lock: the 1Password pass and the owner's imports and saves
 * never interleave, and one that throws does not jam the next.
 */
import { describe, expect, it } from "vitest";
import { serialQueue } from "../src/vaultSerial.js";

describe("serialQueue", () => {
  it("runs sections one at a time, in order, and a throw does not jam the queue", async () => {
    const serial = serialQueue();
    const log: string[] = [];
    const section = (name: string, fail = false) =>
      serial(async () => {
        log.push(`${name} in`);
        await new Promise((r) => setTimeout(r, 5));
        log.push(`${name} out`);
        if (fail) throw new Error("boom");
        return name;
      });
    const [a, b, c] = await Promise.allSettled([section("a"), section("b", true), section("c")]);
    expect(log).toEqual(["a in", "a out", "b in", "b out", "c in", "c out"]);
    expect(a).toEqual({ status: "fulfilled", value: "a" });
    expect(b.status).toBe("rejected");
    expect(c).toEqual({ status: "fulfilled", value: "c" });
  });
});
