import vm from "node:vm";
import { expect, it } from "vitest";
import { PlowApiError } from "../src/plowApi.js";
import { compileMain, mainFunctions } from "./mainSource.js";

// Exercise the shipping old-key recovery without booting Electron (#419).
const compiled = compileMain(...mainFunctions("signInAgainIfOldKey"));

function run(old: boolean | null, revokeError?: Error) {
  const events: string[] = [];
  const settings = { relayCredential: "plow_OLDKEY01_secret" };
  const context = {
    home: "/home", apiBaseUrl: "https://api.plow.co", PlowApiError, console: { log() {} },
    fullAccessCredential: "", checkingKey: false,
    loadSettings: () => ({ ...settings }),
    isSignedIn: () => settings.relayCredential !== "",
    PlowApi: class {
      async holdsOldDeviceKey() { return old; }
      async revokeDeviceCredential() {
        events.push("revoke");
        if (revokeError) throw revokeError;
      }
    },
    signOut: () => { events.push("signOut"); settings.relayCredential = ""; },
    startRelay: async () => { events.push("startRelay"); },
    onboarding: { showMessage: (message: string) => events.push(`message:${message}`) },
  };
  const recover = vm.runInNewContext(`${compiled}; signInAgainIfOldKey`, context) as () => Promise<void>;
  return recover().then(() => events);
}

it("retires an old key, then signs out, restarts the relay and says why", async () => {
  expect(await run(true)).toEqual([
    "revoke", "signOut", "startRelay",
    "message:Plow Latch was updated. Sign in again to keep using it.",
  ]);
});

it("treats an already-retired key as retired", async () => {
  expect(await run(true, new PlowApiError("unauthorized", "Not authorized.", 401))).toContain("signOut");
});

it.each([
  ["a failed retire", true, new Error("offline"), ["revoke"]],
  ["a full-access session", false, undefined, []],
  ["an unknown answer", null, undefined, []],
] as const)("leaves the Mac signed in after %s", async (_name, old, error, expected) => {
  expect(await run(old, error)).toEqual(expected);
});
