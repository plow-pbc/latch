/**
 * The client's start/stop lifecycle, with no relay of any kind.
 *
 * This check lived in `relayClient.test.ts`, deleted with the stand-in relay.
 * It never needed it — a dial that never completes is the whole point, so the
 * socket here is a hand-written stub — and it guards a security property, not
 * a transport detail: a sign-out must not be overtaken by its own in-flight
 * dial. Re-homed for the same reason the wire checks were.
 */
import { describe, expect, it } from "vitest";
import { Connection } from "@domo/transport";
import { RelayClient } from "../src/client.js";

describe("a dial that resolves after stop()", () => {
  /** A socket that records what the client does to it. */
  function fakeConn(): Connection & { closed: boolean; reading: boolean } {
    return {
      onLine: null,
      onClose: null,
      closed: false,
      reading: false,
      startReading() {
        (this as unknown as { reading: boolean }).reading = true;
      },
      sendLine() {},
      close() {
        (this as unknown as { closed: boolean }).closed = true;
      },
    } as unknown as Connection & { closed: boolean; reading: boolean };
  }

  it("closes the socket instead of installing one nobody owns", async () => {
    // Sign-out calls `stop()`, which drops `conn` and stops reconnecting — but
    // it cannot close a connection that has not been handed over yet. A dial
    // still in flight would finish the handshake into an authenticated,
    // reading socket the client no longer tracks, serving agents with a
    // credential the app has already erased.
    const conn = fakeConn();
    let release = () => {};
    const dialing = new Promise<void>((r) => {
      release = () => r();
    });

    const client = new RelayClient({
      url: "ws://example.invalid/relay",
      credential: "plow_sk_test",
      serve: async () => new Response("no"),
      dial: () => ({ connect: async () => { await dialing; return conn; } }),
    });

    const starting = client.start();
    await client.stop();
    release();
    await starting;
    await new Promise((r) => setImmediate(r));

    expect(conn.reading).toBe(false);
    expect(conn.closed).toBe(true);
  });
});
