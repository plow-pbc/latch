/**
 * The timeout contract this Mac shares with the relay.
 *
 * The relay lives in another repository and owns the exchange deadline; this
 * side owns the budgets that have to fit inside it. Both halves are pinned here
 * because getting them out of step is invisible until an agent is already
 * waiting on a response nobody will deliver.
 */
import { describe, expect, it } from "vitest";
import { Connection } from "@domo/transport";
import { DIRECT_CEILING_MS } from "@domo/mcp-server";
import { RelayClient } from "../src/client.js";
import {
  DEFERRABLE_BUDGET_MS,
  deferrableBudgetMs,
  directCeilingMs,
  EXCHANGE_DEADLINE_FIELD,
  FRAME_RESPONSE,
  FRAME_RESPONSE_ACK,
  isResponseAckFrame,
  LEGACY_CALL_BUDGET_MS,
  LEGACY_EXCHANGE_DEADLINE_MS,
  MIN_DELIVERY_MARGIN_MS,
  RELAY_EXCHANGE_DEADLINE_MS,
  RESPONSE_ACK_FIELD,
} from "../src/wire.js";

/** An `auth.ok` from a relay speaking the whole current contract. */
const MODERN_RELAY = {
  [EXCHANGE_DEADLINE_FIELD]: RELAY_EXCHANGE_DEADLINE_MS,
  [RESPONSE_ACK_FIELD]: true,
};

describe("the shared timeout contract", () => {
  it("is twenty-five seconds of exchange, fifteen of budget, ten of margin", () => {
    expect(RELAY_EXCHANGE_DEADLINE_MS).toBe(25_000);
    expect(DEFERRABLE_BUDGET_MS).toBe(15_000);
    expect(MIN_DELIVERY_MARGIN_MS).toBe(10_000);
    // The three are one contract, not three numbers: what is left after the
    // budget IS the delivery margin.
    expect(RELAY_EXCHANGE_DEADLINE_MS - DEFERRABLE_BUDGET_MS).toBe(MIN_DELIVERY_MARGIN_MS);
  });

  it("takes the long budget only once the relay advertises the long deadline", () => {
    expect(deferrableBudgetMs(RELAY_EXCHANGE_DEADLINE_MS)).toBe(DEFERRABLE_BUDGET_MS);
    expect(deferrableBudgetMs(30_000)).toBe(DEFERRABLE_BUDGET_MS);
    // One millisecond short is short.
    expect(deferrableBudgetMs(RELAY_EXCHANGE_DEADLINE_MS - 1)).toBe(LEGACY_CALL_BUDGET_MS);
  });

  it("keeps the old budget when the relay advertises nothing", () => {
    // Relay-first rollout: a new desktop against an old relay must behave
    // exactly as the old desktop did, not assume the deadline it wants.
    expect(deferrableBudgetMs(undefined)).toBe(LEGACY_CALL_BUDGET_MS);
    expect(deferrableBudgetMs(null)).toBe(LEGACY_CALL_BUDGET_MS);
    expect(deferrableBudgetMs("25000")).toBe(LEGACY_CALL_BUDGET_MS);
    expect(deferrableBudgetMs(Number.NaN)).toBe(LEGACY_CALL_BUDGET_MS);
    expect(deferrableBudgetMs(0)).toBe(LEGACY_CALL_BUDGET_MS);
    expect(deferrableBudgetMs(LEGACY_EXCHANGE_DEADLINE_MS)).toBe(LEGACY_CALL_BUDGET_MS);
  });

  it("refuses a deadline too short to leave the delivery margin, rather than shrinking", () => {
    // A clamped budget is not a shorter version of this contract: at a 12s
    // deadline every approval defers instantly AND the margin is gone anyway.
    // The shortest deadline that carries the short budget with its margin
    // intact is 8s + 10s.
    const shortest = LEGACY_CALL_BUDGET_MS + MIN_DELIVERY_MARGIN_MS;
    expect(deferrableBudgetMs(shortest)).toBe(LEGACY_CALL_BUDGET_MS);
    expect(deferrableBudgetMs(shortest - 1)).toBeNull();
    expect(directCeilingMs(shortest - 1)).toBeNull();
    for (const deadline of [17_999, 12_000, 10_000, 1_000]) {
      expect(deferrableBudgetMs(deadline)).toBeNull();
      expect(directCeilingMs(deadline)).toBeNull();
    }
  });

  it("never configures a budget or ceiling that eats its own delivery margin", () => {
    for (const deadline of [30_000, 25_000, 24_999, 20_000, 18_000]) {
      const budget = deferrableBudgetMs(deadline);
      const ceiling = directCeilingMs(deadline);
      expect(budget).not.toBeNull();
      expect(ceiling).not.toBeNull();
      expect(deadline - budget!).toBeGreaterThanOrEqual(MIN_DELIVERY_MARGIN_MS);
      expect(deadline - ceiling!).toBeGreaterThanOrEqual(MIN_DELIVERY_MARGIN_MS);
    }
  });

  it("keeps the direct ceiling short whatever the human's budget grows to", () => {
    // The two answer different questions. A wedged browser action has no handle
    // to hand back, so it must fail while the agent is still there to hear it —
    // lengthening the window a human gets must not lengthen that.
    expect(directCeilingMs(RELAY_EXCHANGE_DEADLINE_MS)).toBe(DIRECT_CEILING_MS);
    expect(directCeilingMs(60_000)).toBe(DIRECT_CEILING_MS);
    expect(directCeilingMs(RELAY_EXCHANGE_DEADLINE_MS)).toBeLessThan(DEFERRABLE_BUDGET_MS);
  });
});

/** A socket that records what the client sends and can push frames back. */
function fakeConn(): Connection & { sent: Record<string, unknown>[] } {
  const conn = {
    onLine: null as ((line: Buffer) => void) | null,
    onClose: null as (() => void) | null,
    sent: [] as Record<string, unknown>[],
    startReading() {},
    sendLine(line: Buffer) {
      conn.sent.push(JSON.parse(line.toString("utf8")) as Record<string, unknown>);
    },
    close() {},
  };
  return conn as unknown as Connection & { sent: Record<string, unknown>[] };
}

/** Push one frame at a client as if the relay had sent it. */
function push(conn: Connection, frame: unknown): void {
  (conn as unknown as { onLine: (line: Buffer) => void }).onLine(
    Buffer.from(JSON.stringify(frame), "utf8"),
  );
}

/** Start a client against `conn` and drive the handshake to `auth.ok`. */
async function handshake(
  conn: Connection & { sent: Record<string, unknown>[] },
  authOk: Record<string, unknown>,
  options: Partial<ConstructorParameters<typeof RelayClient>[0]> = {},
): Promise<RelayClient> {
  const client = new RelayClient({
    url: "ws://relay.invalid/relay",
    credential: "plow_sk_test",
    serve: async () => new Response(JSON.stringify({ ok: true })),
    dial: () => ({ connect: async () => conn }),
    ...options,
  });
  await client.start();
  push(conn, { type: "auth.challenge" });
  push(conn, { type: "auth.ok", ...authOk });
  return client;
}

/** Serve one request frame and wait for the response to be written. */
async function serveOne(conn: Connection, rid: string): Promise<void> {
  push(conn, { type: "relay.request", rid, method: "POST", path: "/mcp", headers: {}, body: null });
  await new Promise((r) => setImmediate(r));
}

describe("the budget the client adopts from a handshake", () => {
  it("takes the long budget from a relay that advertises the long deadline", async () => {
    const conn = fakeConn();
    const seen: unknown[] = [];
    const client = await handshake(conn, MODERN_RELAY, {
      onBudgetChange: (budget) => seen.push(budget),
    });
    expect(client.exchangeDeadlineMs).toBe(RELAY_EXCHANGE_DEADLINE_MS);
    expect(client.callBudgetMs).toBe(DEFERRABLE_BUDGET_MS);
    expect(client.directCeilingMs).toBe(DIRECT_CEILING_MS);
    expect(seen).toEqual([
      {
        budgetMs: DEFERRABLE_BUDGET_MS,
        directCeilingMs: DIRECT_CEILING_MS,
        exchangeDeadlineMs: RELAY_EXCHANGE_DEADLINE_MS,
        acknowledgesResponses: true,
      },
    ]);
    await client.stop();
  });

  it("keeps the old budget against a relay that advertises nothing", async () => {
    const conn = fakeConn();
    const seen: unknown[] = [];
    const client = await handshake(
      conn,
      { ping_interval_ms: 15_000 },
      { onBudgetChange: (budget) => seen.push(budget) },
    );
    expect(client.exchangeDeadlineMs).toBe(LEGACY_EXCHANGE_DEADLINE_MS);
    expect(client.callBudgetMs).toBe(LEGACY_CALL_BUDGET_MS);
    expect(client.directCeilingMs).toBe(DIRECT_CEILING_MS);
    // No acknowledgement capability means none is coming — and nothing here may
    // read meaning into never seeing one.
    expect(client.acknowledgesResponses).toBe(false);
    expect(seen).toEqual([
      {
        budgetMs: LEGACY_CALL_BUDGET_MS,
        directCeilingMs: DIRECT_CEILING_MS,
        exchangeDeadlineMs: LEGACY_EXCHANGE_DEADLINE_MS,
        acknowledgesResponses: false,
      },
    ]);
    await client.stop();
  });

  it("configures nothing at all from a deadline it refuses", async () => {
    const conn = fakeConn();
    const changed: unknown[] = [];
    const refused: number[] = [];
    const client = await handshake(
      conn,
      { [EXCHANGE_DEADLINE_FIELD]: 12_000, [RESPONSE_ACK_FIELD]: true },
      {
        onBudgetChange: (budget) => changed.push(budget),
        onBudgetRefused: (deadline) => refused.push(deadline),
      },
    );
    expect(refused).toEqual([12_000]);
    expect(changed).toEqual([]);
    // The safe defaults stand — including the ack capability, which is not
    // adopted from a handshake this Mac would not plan against.
    expect(client.exchangeDeadlineMs).toBe(LEGACY_EXCHANGE_DEADLINE_MS);
    expect(client.callBudgetMs).toBe(LEGACY_CALL_BUDGET_MS);
    expect(client.acknowledgesResponses).toBe(false);
    await client.stop();
  });
});

describe("the relay's acknowledgement boundary", () => {
  const ackFrame = { type: FRAME_RESPONSE_ACK, rid: "R1" };

  it("recognises an acknowledgement frame and nothing else", () => {
    expect(isResponseAckFrame(ackFrame)).toBe(true);
    expect(isResponseAckFrame({ type: FRAME_RESPONSE_ACK })).toBe(false);
    expect(isResponseAckFrame({ type: FRAME_RESPONSE_ACK, rid: "" })).toBe(false);
    expect(isResponseAckFrame({ type: FRAME_RESPONSE, rid: "R1" })).toBe(false);
    expect(isResponseAckFrame(null)).toBe(false);
  });

  it("reports an acknowledgement only for a rid it actually answered", async () => {
    const conn = fakeConn();
    const acked: string[] = [];
    const client = await handshake(conn, MODERN_RELAY, {
      onResponseAck: (rid) => acked.push(rid),
    });

    // An ack before we have answered anything is not evidence of our delivery.
    push(conn, ackFrame);
    expect(acked).toEqual([]);

    await serveOne(conn, "R1");
    expect(conn.sent.some((f) => f.type === FRAME_RESPONSE && f.rid === "R1")).toBe(true);
    // Answering is not the same as the relay matching it to a waiting exchange.
    expect(acked).toEqual([]);

    push(conn, ackFrame);
    expect(acked).toEqual(["R1"]);

    // Once matched, a repeat is not a second delivery.
    push(conn, ackFrame);
    expect(acked).toEqual(["R1"]);
    await client.stop();
  });

  it("waits for no acknowledgement from a relay that never promised one", async () => {
    // An old relay sends no acks, so tracking a rid for one would be a wait
    // that never ends — and a stray frame claiming to be an ack must not be
    // taken as delivery from a relay that does not implement it.
    const conn = fakeConn();
    const acked: string[] = [];
    const client = await handshake(
      conn,
      { [EXCHANGE_DEADLINE_FIELD]: RELAY_EXCHANGE_DEADLINE_MS },
      { onResponseAck: (rid) => acked.push(rid) },
    );
    expect(client.acknowledgesResponses).toBe(false);

    await serveOne(conn, "R2");
    push(conn, { type: FRAME_RESPONSE_ACK, rid: "R2" });
    expect(acked).toEqual([]);
    await client.stop();
  });

  it("will not acknowledge a response whose request outlived its socket", async () => {
    // The slow case, and the one clearing the map on close cannot catch:
    // serving finishes AFTER a reconnect, so the response is written and
    // tracked while a NEW socket is current. It belongs to the connection it
    // arrived on, and that connection is gone — the new relay session must not
    // be able to acknowledge it.
    const conn = fakeConn();
    const acked: string[] = [];
    let release = () => {};
    const served = new Promise<void>((r) => {
      release = () => r();
    });
    const client = await handshake(conn, MODERN_RELAY, {
      onResponseAck: (rid) => acked.push(rid),
      // Reconnect with no backoff, onto the same socket object.
      random: () => 0,
      serve: async () => {
        await served;
        return new Response("late");
      },
    });

    push(conn, {
      type: "relay.request",
      rid: "R5",
      method: "POST",
      path: "/mcp",
      headers: {},
      body: null,
    });
    // The socket drops and the client redials while the tool is still working.
    (conn as unknown as { onClose: (() => void) | null }).onClose?.();
    await new Promise((r) => setTimeout(r, 10));
    push(conn, { type: "auth.challenge" });
    push(conn, { type: "auth.ok", ...MODERN_RELAY });

    release();
    await new Promise((r) => setImmediate(r));
    expect(conn.sent.some((f) => f.type === FRAME_RESPONSE && f.rid === "R5")).toBe(true);

    push(conn, { type: FRAME_RESPONSE_ACK, rid: "R5" });
    expect(acked).toEqual([]);
    await client.stop();
  });

  it("will not let an acknowledgement cross socket lifetimes", async () => {
    // The response died with the socket that carried it. A reconnected relay
    // replaying — or a fresh socket repeating — that rid is answering for a
    // delivery this client can no longer vouch for.
    const conn = fakeConn();
    const acked: string[] = [];
    const client = await handshake(conn, MODERN_RELAY, {
      onResponseAck: (rid) => acked.push(rid),
    });
    await serveOne(conn, "R9");

    (conn as unknown as { onClose: (() => void) | null }).onClose?.();
    push(conn, { type: "auth.challenge" });
    push(conn, { type: "auth.ok", ...MODERN_RELAY });

    push(conn, { type: FRAME_RESPONSE_ACK, rid: "R9" });
    expect(acked).toEqual([]);
    await client.stop();
  });

  it("stops waiting on an acknowledgement once the exchange cannot still be open", async () => {
    // Without expiry every unmatched rid — a response the relay dropped, one
    // that arrived after the caller gave up — sat in the map for the life of
    // the socket, and an ack arriving an hour late still read as a delivery.
    let clock = 1_000_000;
    const conn = fakeConn();
    const acked: string[] = [];
    const client = await handshake(conn, MODERN_RELAY, {
      onResponseAck: (rid) => acked.push(rid),
      now: () => clock,
    });
    await serveOne(conn, "R7");

    clock += RELAY_EXCHANGE_DEADLINE_MS + 1;
    push(conn, { type: FRAME_RESPONSE_ACK, rid: "R7" });
    expect(acked).toEqual([]);
    await client.stop();
  });
});
