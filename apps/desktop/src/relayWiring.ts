/**
 * How the relay socket is wired to this Mac's MCP server.
 *
 * Four of these callbacks are the entire reason the approval window can tell a
 * user anything true about where their request went: which exchange a call was
 * served on, whether the relay acknowledged the answer, whether it never will,
 * and what budgets the advertised deadline allows. Getting one of them wrong
 * does not break a build or fail a call — it silently turns the window into a
 * guess, which is exactly the failure this feature exists to remove.
 *
 * It lives here, apart from `main.ts`'s startup, so the wiring itself can be
 * driven: `main.ts` builds its `RelayClient` from this, and the verification
 * run builds one from the same function over a scripted socket. A wiring
 * checked by reading it is a wiring nobody checked.
 */
import type { DomoMcpServer } from "@domo/mcp-server";
import type { RelayBudget, RelayClientOptions } from "@domo/relay-client";

/** The parts only the running app can supply. */
export interface RelayHooks {
  url: string;
  credential: string;
  onStatusChange?(connected: boolean): void;
  onAuthFailed?(reason: string): void;
  log?(message: string): void;
  /** Injected in tests; the real one is `new WebSocketDialer(url)`. */
  dial?: RelayClientOptions["dial"];
}

/**
 * Build the relay client's options for `server`.
 *
 * Everything that touches the server is here; everything that touches the app's
 * own state (windows, sign-out, settings) arrives through `hooks`.
 */
export function relayOptions(server: DomoMcpServer, hooks: RelayHooks): RelayClientOptions {
  const say = (message: string) => hooks.log?.(message);
  return {
    url: hooks.url,
    credential: hooks.credential,
    dial: hooks.dial,
    // The rid rides along so whatever this call defers can be matched to the
    // acknowledgement that arrives for that exchange later.
    serve: (request, auth, rid) => server.fetch(request, auth, rid),
    // The relay owns the exchange deadline and advertises it; the budgets that
    // run inside it have to leave delivery margin to spare. A relay that
    // advertises nothing keeps this Mac on the old budget.
    onBudgetChange: (budget: RelayBudget) => {
      server.setCallBudgetMs(budget.budgetMs);
      server.setDirectCeilingMs(budget.directCeilingMs);
      say(
        `call budget ${budget.budgetMs}ms, direct ceiling ${budget.directCeilingMs}ms ` +
          `(exchange deadline ${budget.exchangeDeadlineMs}ms)`,
      );
    },
    // Too short to plan against — nothing is reconfigured, and the reason is
    // worth a line because every call now runs against a deadline this Mac
    // disagrees with.
    onBudgetRefused: (deadlineMs: number) => {
      say(`refused an exchange deadline of ${deadlineMs}ms; keeping safe defaults`);
    },
    // The one thing that may say an operation was backgrounded — and the one
    // thing that says its delivery is unknown. Both are observations off the
    // socket; neither is ever inferred from elapsed time.
    onResponseAck: (rid: string) => server.acknowledgeExchange(rid),
    onDeliveryUnknown: (rid: string) => server.exchangeDeliveryUnknown(rid),
    onStatusChange: hooks.onStatusChange,
    onAuthFailed: hooks.onAuthFailed,
    log: hooks.log,
  };
}
