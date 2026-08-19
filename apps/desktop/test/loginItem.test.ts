import { describe, expect, it } from "vitest";
import { launchAtLoginState, LoginItemApi, setLaunchAtLogin } from "../src/loginItem.js";

/** A stand-in for Electron's login-item API: a settable bit plus a call log. */
function fakeOs(openAtLogin = false) {
  const os = { openAtLogin, writes: [] as boolean[] };
  const api: LoginItemApi = {
    get: () => ({ openAtLogin: os.openAtLogin }),
    set: (settings) => {
      os.writes.push(settings.openAtLogin);
      os.openAtLogin = settings.openAtLogin;
    },
  };
  return { os, api };
}

describe("launchAtLoginState", () => {
  it("reports what the OS holds when supported", () => {
    const { api } = fakeOs(true);
    expect(launchAtLoginState(true, api)).toEqual({ supported: true, openAtLogin: true });
  });

  it("never even reads the OS when unsupported — the dev binary's answer is not this app's", () => {
    const api: LoginItemApi = {
      get: () => {
        throw new Error("must not be called");
      },
      set: () => {
        throw new Error("must not be called");
      },
    };
    expect(launchAtLoginState(false, api)).toEqual({ supported: false, openAtLogin: false });
  });
});

describe("setLaunchAtLogin", () => {
  it("writes the OS bit and answers with a fresh read", () => {
    const { os, api } = fakeOs(false);
    expect(setLaunchAtLogin(true, api, true)).toEqual({ supported: true, openAtLogin: true });
    expect(setLaunchAtLogin(true, api, false)).toEqual({ supported: true, openAtLogin: false });
    expect(os.writes).toEqual([true, false]);
  });

  it("coerces whatever IPC delivered to a boolean before the OS sees it", () => {
    const { os, api } = fakeOs(false);
    setLaunchAtLogin(true, api, "yes" as unknown);
    setLaunchAtLogin(true, api, undefined);
    expect(os.writes).toEqual([true, false]);
  });

  it("REFUSES to write from an unsupported (from-source) run, even via a replayed IPC call", () => {
    const { os, api } = fakeOs(false);
    expect(setLaunchAtLogin(false, api, true)).toEqual({ supported: false, openAtLogin: false });
    expect(os.writes).toEqual([]);
  });

  it("reports the OS's refusal rather than the request — the pane shows what is true", () => {
    const { api } = fakeOs(false);
    const stubborn: LoginItemApi = { get: api.get, set: () => {} };
    expect(setLaunchAtLogin(true, stubborn, true)).toEqual({ supported: true, openAtLogin: false });
  });
});
