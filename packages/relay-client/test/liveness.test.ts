/**
 * A socket that has silently died, and the reconnect that has to follow.
 *
 * The failure this guards is not "the dot is wrong". It is that the dot, the
 * backoff and the status push all hang off `onClose`, and on an unclean drop —
 * wifi gone, or a wake on a different network — nothing ever closes: outbound
 * frames sit in a kernel buffer and no `close` or `error` fires until the OS
 * TCP timeout minutes later. The relay meanwhile writes the device off at twice
 * the heartbeat, so the app says Connected while every call fails and nothing
 * is reconnecting. The whole cycle is asserted here, not just the greying.
 *
 * No relay and no socket: a real unclean drop cannot be produced in `vitest`
 * (it needs a network to take away), so the fake connection below simply stops
 * answering, which is precisely what the kernel presents to us in that case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connection } from "@domo/transport";
import { RelayClient } from "../src/client.js";
import { HEARTBEAT_INTERVAL_MS } from "../src/wire.js";

/** A socket the test drives by hand: it records what was sent, and delivers
 * inbound frames only when the test says so. */
class FakeConn implements Connection {
  onLine: ((line: Buffer) => void) | null = null;
  onClose: (() => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  /** Stops answering, the way a dead network does — nothing is delivered and
   * nothing errors. */
  deaf = false;

  startReading(): void {}

  sendLine(data: Buffer): void {
    const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    this.sent.push(frame);
    if (this.deaf) return;
    // A live relay answers: the handshake, and a pong for every ping.
    if (frame.type === "auth") this.deliver({ type: "auth.ok", device_id: "device-1" });
    if (frame.type === "ping") this.deliver({ type: "pong" });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }

  deliver(frame: Record<string, unknown>): void {
    this.onLine?.(Buffer.from(JSON.stringify(frame), "utf8"));
  }

  /** Drive the handshake the relay starts. */
  handshake(): void {
    this.deliver({ type: "auth.challenge" });
  }
}

describe("a socket that goes silent", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** One client, and every connection it has dialled so far. */
  function harness() {
    const conns: FakeConn[] = [];
    const status: boolean[] = [];
    const client = new RelayClient({
      url: "ws://example.invalid/relay",
      credential: "plow_sk_test",
      deviceId: "device-1",
      serve: async () => new Response("no"),
      onStatusChange: (connected) => status.push(connected),
      // Full jitter picks a delay in [0, ceiling]; pinned so the reconnect
      // lands at a time the test can name.
      random: () => 1,
      dial: () => ({
        connect: async () => {
          const conn = new FakeConn();
          conns.push(conn);
          return conn;
        },
      }),
    });
    return { client, conns, status };
  }

  it.each([
    ["retries a transient failure", "retry", 500, 2, 1],
    ["stays stopped after terminal preparation", "stop", 30_000, 1, 0],
  ] as const)("%s before it opens a socket", async (_case, outcome, elapsed, expectedPreparations, expectedDials) => {
    let preparations = 0;
    let dials = 0;
    let client!: RelayClient;
    client = new RelayClient({
      url: "ws://example.invalid/relay",
      credential: "plow_sk_test",
      deviceId: "device-1",
      serve: async () => new Response("no"),
      beforeConnect: async () => {
        preparations += 1;
        if (outcome === "retry" && preparations === 1) throw new Error("registration unavailable");
        if (outcome === "stop") await client.stop();
      },
      random: () => 1,
      dial: () => ({
        connect: async () => {
          dials += 1;
          return new FakeConn();
        },
      }),
    });

    await client.start();
    await vi.advanceTimersByTimeAsync(elapsed);
    expect(preparations).toBe(expectedPreparations);
    expect(dials).toBe(expectedDials);
    await client.stop();
  });

  it("drops it, greys the dot, and reconnects", async () => {
    const { client, conns, status } = harness();
    await client.start();
    conns[0].handshake();
    expect(conns[0].sent[0]).toMatchObject({
      type: "auth",
      token: "plow_sk_test",
      device_id: "device-1",
    });
    expect(client.isConnected).toBe(true);
    expect(status).toEqual([true]);

    // Wifi vanishes. The socket neither closes nor errors — it just stops
    // answering, and our pings go into a buffer nobody drains.
    conns[0].deaf = true;

    // One heartbeat later we are still nominally fine: a single missed beat is
    // not evidence, and the relay has not written us off either.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(client.isConnected).toBe(true);
    expect(conns[0].closed).toBe(false);

    // The second beat with nothing inbound is. The client closes the socket
    // itself, which is what makes the dot grey and the backoff start.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(conns[0].closed).toBe(true);
    expect(client.isConnected).toBe(false);
    expect(status).toEqual([true, false]);

    // ...and the backoff brings it back. First attempt, full jitter pinned to
    // the ceiling: 500ms, then the handshake on the new socket.
    await vi.advanceTimersByTimeAsync(500);
    expect(conns).toHaveLength(2);
    conns[1].handshake();
    expect(client.isConnected).toBe(true);
    expect(status).toEqual([true, false, true]);

    // The new socket is a working one: it heartbeats and is not dropped again.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 4);
    expect(conns[1].closed).toBe(false);
    expect(client.isConnected).toBe(true);
    expect(conns).toHaveLength(2);

    await client.stop();
  });

  it("notices a socket that dies before the handshake ever finishes", async () => {
    // The stall the first cut of this missed: liveness armed at `auth.ok` does
    // nothing for a socket that opens and then goes quiet, because the
    // `auth.ok` that would have started the watching never arrives. Nothing
    // closes, nothing reconnects, and the app sits on a dead socket until the
    // OS timeout — with no status change to show for it either, since it never
    // reached Connected in the first place.
    const { client, conns, status } = harness();
    await client.start();
    // No handshake: the relay never even sends its challenge.
    expect(status).toEqual([]);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    expect(conns[0].closed).toBe(true);
    // Nothing was pinged at it: pre-`auth.ok` the beat only watches, because
    // the relay is mid-handshake and an unexpected frame is not ours to invent.
    expect(conns[0].sent).toEqual([]);
    // It never claimed Connected, so there is no status to retract.
    expect(status).toEqual([]);

    // And it does not sit there: the backoff redials, and this socket answers.
    await vi.advanceTimersByTimeAsync(500);
    expect(conns).toHaveLength(2);
    conns[1].handshake();
    expect(client.isConnected).toBe(true);
    expect(status).toEqual([true]);

    await client.stop();
  });

  it("does not hold a replacement socket to the last relay's cadence", async () => {
    // The advertised cadence belongs to the connection that advertised it. Kept
    // across a redial it becomes a trap: a relay that asked for a 1s beat leaves
    // the next socket on a 2s pre-auth fuse, so a healthy replacement whose
    // handshake takes a moment longer is closed on sight — and the one after
    // that, and the one after that, which is a reconnect loop that never lands.
    const { client, conns, status } = harness();
    await client.start();
    conns[0].deliver({ type: "auth.challenge" });
    conns[0].deliver({ type: "auth.ok", device_id: "device-1", ping_interval_ms: 1000 });
    expect(client.isConnected).toBe(true);

    // That relay goes silent and is dropped on its own (fast) cadence.
    conns[0].deaf = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(conns[0].closed).toBe(true);

    // The redial lands, and this relay is fine — it is simply slower to say
    // hello than the last one's two beats.
    await vi.advanceTimersByTimeAsync(500);
    expect(conns).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(conns[1].closed).toBe(false);
    expect(conns).toHaveLength(2);

    conns[1].handshake();
    expect(client.isConnected).toBe(true);
    expect(status).toEqual([true, false, true]);

    await client.stop();
  });

  it("counts any inbound frame as proof of life, not just a pong", async () => {
    // The relay is under load and answers no pings, but is plainly alive: it is
    // still pushing frames down the socket. Dropping that connection would kill
    // a working tunnel.
    const { client, conns } = harness();
    await client.start();
    conns[0].handshake();
    conns[0].deaf = true;

    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
      conns[0].deliver({ type: "ping" });
    }
    expect(conns[0].closed).toBe(false);
    expect(client.isConnected).toBe(true);

    await client.stop();
  });
});
