/**
 * What the relay socket is wired to.
 *
 * Four of these callbacks are the only reason the approval window can say
 * anything true about where a request went. None of them fails loudly when
 * miswired: the calls still work, the build still passes, and the window
 * quietly becomes a guess — which is the exact failure this feature exists to
 * remove. So the wiring is checked rather than read.
 */
import { describe, expect, it } from "vitest";
import { relayOptions } from "../src/relayWiring.js";

/** The server surface the wiring touches, recording what it is asked. */
function fakeServer() {
  const calls: { name: string; args: unknown[] }[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return undefined;
    };
  return {
    calls,
    names: () => calls.map((c) => c.name),
    server: {
      fetch: (...args: unknown[]) => {
        calls.push({ name: "fetch", args });
        return Promise.resolve(new Response("served"));
      },
      setCallBudgetMs: record("setCallBudgetMs"),
      setDirectCeilingMs: record("setDirectCeilingMs"),
      acknowledgeExchange: record("acknowledgeExchange"),
      exchangeDeliveryUnknown: record("exchangeDeliveryUnknown"),
    },
  };
}

const wire = (hooks: Partial<Parameters<typeof relayOptions>[1]> = {}) => {
  const f = fakeServer();
  const options = relayOptions(f.server as never, {
    url: "ws://relay.invalid/relay",
    credential: "plow_sk_test",
    ...hooks,
  });
  return { ...f, options };
};

describe("the relay's observations reach the server", () => {
  it("carries an acknowledgement to the exchange it names", () => {
    const { options, calls } = wire();
    options.onResponseAck!("RID-7");
    expect(calls).toEqual([{ name: "acknowledgeExchange", args: ["RID-7"] }]);
  });

  it("carries an unconfirmed delivery, and never as an acknowledgement", () => {
    // The two are not interchangeable: one says the handoff happened, the other
    // says nobody can tell. Crossing them would have the window claim a
    // delivery that never happened.
    const { options, calls } = wire();
    options.onDeliveryUnknown!("RID-8");
    expect(calls).toEqual([{ name: "exchangeDeliveryUnknown", args: ["RID-8"] }]);
  });

  it("serves a request with the rid it arrived on", async () => {
    // Without the rid, nothing can match a later acknowledgement to whatever
    // this call deferred, and no operation can ever be backgrounded.
    const { options, calls } = wire();
    const request = new Request("http://mac/mcp", { method: "POST" });
    const auth = { agent_id: "sess_1" };
    await options.serve(request, auth as never, "RID-9");
    expect(calls).toEqual([{ name: "fetch", args: [request, auth, "RID-9"] }]);
  });
});

describe("the advertised deadline configures the budgets", () => {
  it("sets both budgets from one handshake", () => {
    const said: string[] = [];
    const { options, calls } = wire({ log: (m) => said.push(m) });
    options.onBudgetChange!({
      budgetMs: 15_000,
      directCeilingMs: 15_000,
      exchangeDeadlineMs: 25_000,
      acknowledgesResponses: true,
    });
    expect(calls).toEqual([
      { name: "setCallBudgetMs", args: [15_000] },
      { name: "setDirectCeilingMs", args: [15_000] },
    ]);
    expect(said.join(" ")).toContain("25000ms");
  });

  it("changes nothing at all on a deadline this Mac refuses", () => {
    const said: string[] = [];
    const { options, calls } = wire({ log: (m) => said.push(m) });
    options.onBudgetRefused!(12_000);
    expect(calls).toEqual([]);
    expect(said.join(" ")).toContain("refused");
  });
});

describe("what the app keeps for itself", () => {
  it("passes the app's own hooks through untouched", () => {
    const seen: unknown[] = [];
    const { options } = wire({
      onStatusChange: (c) => seen.push(["status", c]),
      onAuthFailed: (r) => seen.push(["auth", r]),
    });
    options.onStatusChange!(true);
    options.onAuthFailed!("revoked");
    expect(seen).toEqual([
      ["status", true],
      ["auth", "revoked"],
    ]);
  });

  it("never puts the credential anywhere but the client's own field", () => {
    const { options } = wire();
    expect(options.credential).toBe("plow_sk_test");
    // Nothing else in the options object mentions it — not the url, not a
    // callback's closure output.
    const rest = { ...options, credential: undefined };
    expect(JSON.stringify(rest)).not.toContain("plow_sk_test");
  });
});
