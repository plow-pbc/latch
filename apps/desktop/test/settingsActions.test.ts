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
import {
  isSignedIn,
  PendingRevokeRetrier,
  queueRevokeAndSignOut,
  readAgentPurpose,
  readInference,
  setAgentPurpose,
  setApprovalMode,
  signOutOfPlow,
} from "../src/settingsActions.js";
import { PlowApiError } from "../src/plowApi.js";

const PLOW_CREDENTIAL = "plow_sk_do_not_leak_me";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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
    setupComplete: false,
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
      setupComplete: true,
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

describe("signing out queues the credential atomically", () => {
  const homeSignedIn = (overrides: Partial<Settings> = {}) =>
    homeWith({
      relayCredential: PLOW_CREDENTIAL,
      accountUid: "u_someone",
      mcpUrl: "https://api.plow.co/v1/relay/devices/u_someone/mcp",
      approvalMode: "adversarial",
      ...overrides,
    });

  it("moves the active credential into the durable queue while clearing local state", () => {
    const home = homeSignedIn();

    queueRevokeAndSignOut(home);

    expectSignedOutWithAdversarial(home);
    expect(stored(home).pendingRevokeCredentials).toEqual([PLOW_CREDENTIAL]);
  });

  it("is a no-op for the queue when there is no active credential", () => {
    const home = homeWith({ relayCredential: "" });
    queueRevokeAndSignOut(home);
    expect(stored(home).pendingRevokeCredentials).toEqual([]);
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

  it("and the queueing half is already idempotent", () => {
    const home = homeWith({ relayCredential: PLOW_CREDENTIAL });
    queueRevokeAndSignOut(home);
    queueRevokeAndSignOut(home);
    expect(stored(home).pendingRevokeCredentials).toEqual([PLOW_CREDENTIAL]);
  });
});

describe("pending session revocation", () => {
  it("keeps failures for the next heartbeat, then clears them on success", async () => {
    const home = homeWith({ pendingRevokeCredentials: [PLOW_CREDENTIAL] });
    let offline = true;
    const retrier = new PendingRevokeRetrier(home, async () => {
      if (offline) throw new Error("offline");
    });

    await retrier.start();
    expect(stored(home).pendingRevokeCredentials).toEqual([PLOW_CREDENTIAL]);

    offline = false;
    await retrier.start();
    expect(stored(home).pendingRevokeCredentials).toEqual([]);
  });

  it("treats unauthorized as confirmation that the old credential is already unusable", async () => {
    const home = homeWith({ pendingRevokeCredentials: [PLOW_CREDENTIAL] });
    const retrier = new PendingRevokeRetrier(home, async () => {
      throw new PlowApiError("unauthorized", "Not authorized.", 401);
    });

    await retrier.start();
    expect(stored(home).pendingRevokeCredentials).toEqual([]);
  });

  it("single-flights overlapping launch and connectivity retries", async () => {
    const home = homeWith({ pendingRevokeCredentials: [PLOW_CREDENTIAL] });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let attempts = 0;
    const retrier = new PendingRevokeRetrier(home, async () => {
      attempts += 1;
      await held;
    });

    const fromLaunch = retrier.start();
    const fromConnection = retrier.start();
    expect(fromConnection).toBe(fromLaunch);
    expect(attempts).toBe(1);

    release();
    await fromLaunch;
    expect(stored(home).pendingRevokeCredentials).toEqual([]);
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
