/**
 * A vault that stops answering must fail, not hang.
 *
 * Every vault call goes through `send`, so this one timeout is what keeps a
 * wedged local vault — a suspended process, an orphan from an older install
 * still holding the port — from becoming a Vault tab that never opens
 * (plow-pbc/latch#193).
 */
import net from "node:net";
import { describe, expect, it } from "vitest";
import { send } from "../src/browser/vaultCrypto.js";

/** A listener that accepts the connection and then says nothing, ever — the
 *  shape of a vault process that is up but not serving. */
async function deafServer(): Promise<{ port: number; close: () => void }> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => sockets.push(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

describe("send", () => {
  it("gives up on a vault that never answers", async () => {
    const server = await deafServer();
    try {
      await expect(
        send({ url: `https://127.0.0.1:${server.port}` }, "GET", "/api/ciphers", undefined, "application/json", 200),
      ).rejects.toThrow(/did not answer/);
    } finally {
      server.close();
    }
  });
});
