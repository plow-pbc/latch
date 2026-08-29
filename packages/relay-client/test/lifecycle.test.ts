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

describe("a dial that resolves after stop()", () => {
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

describe("an authentication refusal", () => {
  it("does not pass the relay's reason to a log or callback", async () => {
    const credential = "plow_sk_device_do_not_leak";
    const reason = `credential ${credential} is invalid`;
    const logs: string[] = [];
    const callbackArgs: unknown[][] = [];
    const conn = fakeConn();
    const client = new RelayClient({
      url: "ws://example.invalid/relay",
      credential,
      serve: async () => new Response("no"),
      log: (message) => logs.push(message),
      onAuthFailed: (...args: unknown[]) => callbackArgs.push(args),
      dial: () => ({ connect: async () => conn }),
    });

    await client.start();
    logs.length = 0;
    conn.onLine?.(Buffer.from(JSON.stringify({ type: "auth.error", reason }), "utf8"));

    expect(logs).toEqual(["relay rejected the credential"]);
    expect(callbackArgs).toEqual([[]]);
  });
});
