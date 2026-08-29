/**
 * The enforcement side of the reviewer interlock — the code the IPC handlers
 * run, not the helpers they consult.
 *
 * The distinction matters: the availability helpers were already tested, and
 * they stayed green while nothing proved the handlers actually *called* them.
 * These tests execute the mutations and then re-read the settings **from
 * disk**, because a rule that does not survive a relaunch is not a rule.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, saveSettings, Settings } from "../src/settings.js";
import { PlowApiError } from "../src/plowApi.js";
import {
  isSignedIn,
  readAgentPurpose,
  readInference,
  revokeAndSignOut,
  setAgentPurpose,
  setApprovalMode,
  signOutOfPlow,
} from "../src/settingsActions.js";

const PLOW_CREDENTIAL = "plow_sk_do_not_leak_me";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** A throwaway DOMO_HOME with the given settings already written. */
function homeWith(overrides: Partial<Settings> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-actions-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  saveSettings(dir, { ...loadSettings(dir), ...overrides });
  return dir;
}

/** What actually survived to disk. */
const stored = (home: string) => loadSettings(home);

/**
 * What every sign-out leaves behind, however it got there.
 *
 * The mode is the interesting half: Adversarial SURVIVES. It cannot run, and
 * that is the point — every operation it decides is denied with `no_reviewer`
 * until a credential comes back, instead of the mode being quietly swapped for
 * Ask behind the person who chose it.
 */
function expectSignedOutWithAdversarial(home: string) {
  expect(stored(home)).toMatchObject({
    relayCredential: "",
    accountUid: "",
    mcpUrl: "",
    approvalMode: "adversarial",
  });
}

describe("Plow sign-out forgets the credential and leaves the mode alone", () => {
  it("forgets the credential and keeps the stored mode", () => {
    const home = homeWith({
      approvalMode: "adversarial",
      relayCredential: PLOW_CREDENTIAL,
      accountUid: "u_someone",
      mcpUrl: "https://api.plow.co/v1/relay/devices/u_someone/mcp",
    });

    signOutOfPlow(home);

    expectSignedOutWithAdversarial(home);
  });

  it("signing out with Adversarial selected leaves the mode alone", () => {
    const home = homeWith({
      approvalMode: "adversarial",
      relayCredential: PLOW_CREDENTIAL,
    });

    signOutOfPlow(home);

    expect(stored(home).relayCredential).toBe("");
    expect(stored(home).approvalMode).toBe("adversarial");
  });

  it("does not disturb the other approval modes", () => {
    for (const mode of ["approve", "ask", "deny"] as const) {
      const home = homeWith({ approvalMode: mode, relayCredential: PLOW_CREDENTIAL });
      signOutOfPlow(home);
      expect(stored(home).approvalMode).toBe(mode);
    }
  });
});

describe("Adversarial mode is selectable whether or not a reviewer can run", () => {
  it("stores it even with no credential — it denies rather than being refused", () => {
    const home = homeWith({ approvalMode: "ask", relayCredential: "" });
    expect(setApprovalMode(home, "adversarial")).toBe("adversarial");
    expect(stored(home).approvalMode).toBe("adversarial");
  });

  it("accepts it when the active provider has a credential", () => {
    const home = homeWith({ relayCredential: PLOW_CREDENTIAL });
    expect(setApprovalMode(home, "adversarial")).toBe("adversarial");
    expect(stored(home).approvalMode).toBe("adversarial");
  });

  it("stores the other modes as asked, and unknown input as ask", () => {
    const home = homeWith({ relayCredential: PLOW_CREDENTIAL });
    for (const mode of ["approve", "deny", "ask"] as const) {
      expect(setApprovalMode(home, mode)).toBe(mode);
      expect(stored(home).approvalMode).toBe(mode);
    }
    for (const junk of ["yolo", "", null, 3]) {
      expect(setApprovalMode(home, junk)).toBe("ask");
      expect(stored(home).approvalMode).toBe("ask");
    }
  });
});

describe("the persisted file keeps its guarantees", () => {
  it("what the renderer is handed never contains the credential", () => {
    const home = homeWith({ relayCredential: PLOW_CREDENTIAL });
    const serialized = JSON.stringify(readInference(home));
    expect(serialized).not.toContain(PLOW_CREDENTIAL);
    expect(serialized).not.toContain(PLOW_CREDENTIAL.slice(0, 10));
  });
});

describe("signing out retires the credential server-side, best effort", () => {
  const homeSignedIn = () =>
    homeWith({
      relayCredential: PLOW_CREDENTIAL,
      accountUid: "u_someone",
      mcpUrl: "https://api.plow.co/v1/relay/devices/u_someone/mcp",
      approvalMode: "adversarial",
    });

  it("asks Plow to revoke, using the credential being retired", async () => {
    const home = homeSignedIn();
    const seen: string[] = [];
    // Observed inside the callback, asserted OUTSIDE it. An expect() in there
    // would be swallowed by the best-effort catch this very function relies on,
    // and the test would pass with the ordering reversed.
    let onDiskWhenAsked: string | null = null;

    // ...and it reports that the revoke landed. The caller needs the answer:
    // the credential is the owner's login session, so one this Mac could not
    // retire stays live on the account with nothing here able to reach it.
    expect(
      await revokeAndSignOut(home, async (credential) => {
        seen.push(credential);
        onDiskWhenAsked = stored(home).relayCredential;
      }),
    ).toBe(true);

    expect(seen).toEqual([PLOW_CREDENTIAL]);
    // The revoke authenticates with the CAPTURED token, so the disk copy is
    // already gone by the time we ask — see the quit test below for why.
    expect(onDiskWhenAsked).toBe("");
    expect(stored(home).relayCredential).toBe("");
  });

  it("the credential is off disk BEFORE the revoke is even asked", async () => {
    // Position 1 of the sign-out contract: the local erase is the half this app
    // guarantees, so it happens synchronously, before the first await, and does
    // not depend on the network call that follows it. A revoke that never
    // settles is exactly what a hung network looks like.
    const home = homeSignedIn();
    let onDiskWhenAsked: string | null = null;

    // Observed inside the callback, asserted OUTSIDE it: an expect() in there
    // would be swallowed by the best-effort catch this very function relies on.
    void revokeAndSignOut(home, async () => {
      onDiskWhenAsked = stored(home).relayCredential;
      await new Promise(() => {}); // never settles
    });
    await new Promise((r) => setImmediate(r));

    expect(onDiskWhenAsked).toBe("");
    expectSignedOutWithAdversarial(home);
  });

  it("clears locally even when the revoke FAILS", async () => {
    // Offline, API down, route not deployed — the case that matters most,
    // because a Mac that cannot reach Plow is the one whose owner most wants
    // the local copy gone.
    const home = homeSignedIn();

    // ...and reports the failure rather than swallowing it: the credential is
    // the owner's login session, so one left live is theirs to retire.
    await expect(
      revokeAndSignOut(home, async () => {
        throw new Error("ENOTFOUND api.plow.co");
      }),
    ).resolves.toBe(false);

    expectSignedOutWithAdversarial(home);
    // ...and KEEPS the session it could not retire. Sign-out has just erased
    // the only copy of a live `*:*` bearer, so dropping it here left the
    // account holding one for 180 days with nothing anywhere able to revoke
    // it. It goes to the same pending list `Onboarding` uses, and the app
    // retries it on the next launch and the next activation.
    expect(stored(home).pendingRevocations).toEqual([PLOW_CREDENTIAL]);
  });

  it("stages the session BEFORE the revoke, so a quit mid-flight survives it", async () => {
    // Sign-out clears the credential synchronously and then waits on the
    // network. Staging only after that call failed left a window with the
    // token nowhere on disk — and quitting inside it is indistinguishable from
    // a failed revoke, except that nothing was left to retry with.
    const home = homeSignedIn();
    let staged: string[] = [];
    await revokeAndSignOut(home, async () => {
      // Mid-flight: the app could be quit right here.
      staged = [...stored(home).pendingRevocations];
      expect(stored(home).relayCredential).toBe("");
    });

    expect(staged).toEqual([PLOW_CREDENTIAL]);
    // ...and a revoke that lands releases it again.
    expect(stored(home).pendingRevocations).toEqual([]);
  });

  it("clears locally for every shape of failure", async () => {
    for (const fail of [
      () => Promise.reject(new Error("500")),
      () => Promise.reject("a bare string"),
      () => Promise.reject(new PlowApiError("http", "Plow returned 404.", 404)),
    ]) {
      const home = homeSignedIn();
      await revokeAndSignOut(home, fail as () => Promise<unknown>);
      expect(stored(home).relayCredential).toBe("");
    }
  });

  it("does not call out at all when there is nothing to revoke", async () => {
    const home = homeWith({ relayCredential: "" });
    const revoke = vi.fn();
    // Nothing to retire IS success: there is no session left loose.
    expect(await revokeAndSignOut(home, revoke)).toBe(true);
    expect(revoke).not.toHaveBeenCalled();
    expect(stored(home).relayCredential).toBe("");
  });

  it("a failing revoke leaks nothing about the credential", async () => {
    const home = homeSignedIn();
    const logs: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    }

    await revokeAndSignOut(home, async () => {
      throw new Error(`failed for Bearer ${PLOW_CREDENTIAL}`);
    });

    expect(logs.join("\n")).not.toContain(PLOW_CREDENTIAL);
    expect(logs.join("\n")).not.toContain(PLOW_CREDENTIAL.slice(0, 10));
    vi.restoreAllMocks();
  });
});

describe("a second sign-out is a no-op, not a second sign-out", () => {
  it("reports nothing left to sign out of once the credential is gone", () => {
    // The double-click path. Two handlers dispatch before the button
    // re-renders; the first clears the credential, and this is what stops the
    // second from resetting the setup window and minting a code over one the
    // user may already have texted.
    const home = homeWith({ relayCredential: PLOW_CREDENTIAL, accountUid: "u_someone" });
    expect(isSignedIn(home)).toBe(true);

    signOutOfPlow(home);

    expect(isSignedIn(home)).toBe(false);
  });

  it("treats a whitespace-only credential as signed out", () => {
    expect(isSignedIn(homeWith({ relayCredential: "   " }))).toBe(false);
  });

  it("and the revoke half is already idempotent", async () => {
    const home = homeWith({ relayCredential: PLOW_CREDENTIAL });
    const revoke = vi.fn(async () => {});
    await revokeAndSignOut(home, revoke);
    await revokeAndSignOut(home, revoke); // the second click
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe("the purpose statement is owner-authored data", () => {
  it("stores what the owner wrote, and reads it back from disk", () => {
    const home = homeWith();
    expect(readAgentPurpose(home)).toBe("");

    const stored = setAgentPurpose(home, "Groceries and calendar. Never touch ~/Developer.");

    // The return value is what was stored, not what was sent — a caller shows
    // the file's truth rather than its own optimistic guess.
    expect(stored).toBe("Groceries and calendar. Never touch ~/Developer.");
    expect(readAgentPurpose(home)).toBe("Groceries and calendar. Never touch ~/Developer.");
  });

  it("clears on empty, so a purpose can be taken back as easily as it was given", () => {
    const home = homeWith({ agentPurpose: "Groceries only." });
    expect(setAgentPurpose(home, "")).toBe("");
    expect(readAgentPurpose(home)).toBe("");
  });

  it("trims the edges but keeps the shape of what was typed", () => {
    const home = homeWith();
    setAgentPurpose(home, "  Groceries.\nNever ~/Developer.\n\n");
    expect(readAgentPurpose(home)).toBe("Groceries.\nNever ~/Developer.");
  });

  /**
   * The renderer is sandboxed but still the untrusted side of the bridge, and
   * this string is interpolated into the reviewer's prompt. A hand-made or
   * replayed IPC call must not be able to park a non-string there.
   */
  it("coerces anything that is not a string to empty", () => {
    for (const bad of [null, undefined, 42, { toString: () => "sneaky" }, ["a"], true]) {
      const home = homeWith({ agentPurpose: "Groceries only." });
      expect(setAgentPurpose(home, bad)).toBe("");
      expect(readAgentPurpose(home)).toBe("");
    }
  });

  /**
   * Every setter shares one read-modify-write, so writing a purpose must not
   * change anything else on its way through — least of all the approval mode,
   * which is the owner's answer to a different question.
   *
   * This used to assert the opposite for the second case: writing a purpose
   * re-applied an interlock that retired a credential-less Adversarial mode to
   * Ask. That interlock is gone. A mode whose reviewer cannot run is a legal
   * state that denies and explains itself, so the mode survives the write.
   */
  for (const c of [
    { name: "with a credential", over: { relayCredential: PLOW_CREDENTIAL } },
    { name: "without one", over: { relayCredential: "" } },
  ]) {
    it(`leaves the stored mode alone, ${c.name}`, () => {
      const home = homeWith({ approvalMode: "adversarial", ...c.over });
      setAgentPurpose(home, "Groceries only.");
      expect(stored(home).approvalMode).toBe("adversarial");
    });
  }
});

