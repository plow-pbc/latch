import vm from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CONNECTOR_SETUP_WAIT_MS, Connectors } from "../src/connectors.js";
import { PlowApi } from "../src/plowApi.js";
import { compileMain, mainFunctions } from "./mainSource.js";

// Plugins → Continue's shipping access decision, without Electron.
const compiled = compileMain(...mainFunctions("accessNeeded"));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each([
  { name: "a resumed setup reads a connected Google from Plow", primed: false, plowHangs: false, needed: false },
  { name: "a hanging Plow answers from the polled accounts", primed: true, plowHangs: true, needed: false },
  { name: "a hanging Plow with nothing polled yet asks for access", primed: false, plowHangs: true, needed: true },
])("answers within the wait: $name", async ({ primed, plowHangs, needed }) => {
  let hang = false;
  const connectors = new Connectors({
    api: {
      listConnectors: () => hang
        ? new Promise(() => {})
        : Promise.resolve({ google: { accounts: [{ email: "owner@example.com", isDefault: true }] } }),
    } as unknown as PlowApi,
    credential: () => "plow_resumed_setup_credential",
    openExternal: async () => {},
    recordAudit: () => {},
  });
  if (primed) await connectors.poll();
  hang = plowHangs;
  const accessNeeded = vm.runInNewContext(`${compiled}; accessNeeded`, {
    connectors,
    setTimeout,
    CONNECTOR_SETUP_WAIT_MS,
    // Gmail's grant is met exactly when an account is connected.
    pluginsNow: async () => ({
      grants: [{ status: connectors.state().google.accounts.length ? "met" : "open" }],
    }),
  }) as () => Promise<boolean>;

  let answer: boolean | null = null;
  void accessNeeded().then((result) => { answer = result; });
  await vi.advanceTimersByTimeAsync(CONNECTOR_SETUP_WAIT_MS);

  expect(answer).toBe(needed);
});
