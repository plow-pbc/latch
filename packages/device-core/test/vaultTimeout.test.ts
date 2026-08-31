/**
 * A vault that stops answering must fail a read, not hang — and must not fail a
 * write it may already have committed.
 *
 * The read timeout is what keeps a wedged local vault — a suspended process, an
 * orphan from an older install still holding the port — from becoming a Vault
 * tab that never opens (plow-pbc/latch#193). It is opt-in per request because a
 * timed-out write would report a failure that did happen, and the retry would
 * strand a second account or a duplicate item.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { send, VAULT_READ_TIMEOUT_MS } from "../src/browser/vaultCrypto.js";
import { listen, mint } from "./vaultTestServer.js";

/** A listener that accepts the connection and then says nothing, ever — the
 *  shape of a vault process that is up but not serving. */
async function deafServer(): Promise<{ url: string; close: () => void }> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => sockets.push(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `https://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

/** A vault that promises a body and then drops the connection — the shape of one
 *  that dies mid-answer. */
async function diesMidAnswer(): Promise<{ url: string; ca: Buffer; close: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-stall-"));
  const pair = mint(dir, "vault");
  const server = await listen(pair, (sock) => {
    // Content-Length promises 99 bytes; one is sent, then the socket goes.
    sock.write("HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\n{");
    setTimeout(() => sock.destroy(), 50);
  });
  return {
    url: `https://127.0.0.1:${server.port}`,
    ca: fs.readFileSync(pair.cert),
    close: () => {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("send", () => {
  it("gives up on a read the vault never answers", async () => {
    const server = await deafServer();
    try {
      await expect(
        send({ url: server.url }, "GET", "/api/ciphers", undefined, "application/json", 200),
      ).rejects.toThrow(/did not answer/);
    } finally {
      server.close();
    }
  });

  it("leaves a write to wait, because the vault may have committed it", async () => {
    const server = await deafServer();
    // Whichever settles first: the request, or a wait far shorter than any
    // timeout it could have inherited. A rejection here would mean writes are
    // being given a deadline they cannot honestly report on. The window has to
    // clear the socket timer's own start-up lag — a 200ms request timeout fires
    // nearer 400ms — or a write that IS timed out would still look pending.
    const WINDOW_MS = 800;
    const settled = Promise.race([
      send({ url: server.url }, "POST", "/identity/accounts/register", "{}").then(
        () => "answered",
        (e) => `gave up: ${e.message}`,
      ),
      new Promise((r) => setTimeout(() => r("pending"), WINDOW_MS)),
    ]);
    try {
      expect(VAULT_READ_TIMEOUT_MS).toBeGreaterThan(WINDOW_MS);
      await expect(settled).resolves.toBe("pending");
    } finally {
      server.close();
    }
  });

  it("fails a read whose answer stops early, instead of hanging on it", async () => {
    const server = await diesMidAnswer();
    try {
      // Deliberately untimed: a truncated body fails the response object, which
      // the request's own `error` never hears about. Listening only there left
      // this promise unsettled forever — a hang the timeout cannot save, since
      // headers arrived and the socket is already gone.
      await expect(
        send({ url: server.url, ca: server.ca }, "GET", "/api/ciphers"),
      ).rejects.toThrow();
    } finally {
      server.close();
    }
  });
});
