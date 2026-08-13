/**
 * The enforcement side of the reviewer interlock — the code the IPC handlers
 * run, not the helpers they consult.
 *
 * The distinction matters: the availability helpers were already tested, and
 * they stayed green while nothing proved the handlers actually *called* them.
 * Deleting the guard that refuses an unavailable provider, or forgetting to
 * persist the fallback to Ask, left every test passing. These tests execute the
 * guards and then re-read the settings **from disk**, because an interlock that
 * does not survive a relaunch is not an interlock.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, saveSettings, Settings } from "../src/settings.js";
import { PlowApiError } from "../src/plowApi.js";
import {
  readInference,
  revokeAndSignOut,
  setAnthropicApiKey,
  setApprovalMode,
  setInferenceProvider,
  signOutOfPlow,
} from "../src/settingsActions.js";

const PLOW_CREDENTIAL = "plow_sk_do_not_leak_me";
const ANTHROPIC_KEY = "sk-ant-do-not-leak-me";

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

describe("selecting a provider is refused by main, not merely hidden in the UI", () => {
  it("refuses a provider with no credential, and persists nothing", () => {
    // The renderer is sandboxed but still the untrusted side of the bridge. A
    // replayed or hand-made IPC call must not park the reviewer on a provider
    // that can never answer.
    const home = homeWith({ inferenceProvider: "plow", relayCredential: PLOW_CREDENTIAL });

    const status = setInferenceProvider(home, "anthropic");

    expect(stored(home).inferenceProvider).toBe("plow");
    expect(status.provider).toBe("plow");
    expect(status.available.anthropic).toBe(false);
  });

  it("allows a provider that does have a credential", () => {
    const home = homeWith({
      inferenceProvider: "plow",
      relayCredential: PLOW_CREDENTIAL,
      anthropicApiKey: ANTHROPIC_KEY,
    });

    expect(setInferenceProvider(home, "anthropic").provider).toBe("anthropic");
    expect(stored(home).inferenceProvider).toBe("anthropic");
  });

  it("refuses a provider name nobody recognises", () => {
    const home = homeWith({ inferenceProvider: "plow", relayCredential: PLOW_CREDENTIAL });
    for (const junk of ["openai", "", null, 7, { provider: "plow" }, ["plow"]]) {
      setInferenceProvider(home, junk);
      expect(stored(home).inferenceProvider).toBe("plow");
    }
  });

  it("reports the truth back to the renderer on a refusal", () => {
    // A refused call still answers with the real state, so the renderer cannot
    // sit on an optimistic guess about which provider is live.
    const home = homeWith({ inferenceProvider: "plow", relayCredential: PLOW_CREDENTIAL });
    expect(setInferenceProvider(home, "anthropic")).toEqual(readInference(home));
  });

  it("switching providers retires Adversarial mode when the new one is unusable", () => {
    // Not reachable through the UI today, but the guard is what makes that a
    // UI detail rather than the only thing standing between the reviewer and a
    // mode it cannot serve.
    const home = homeWith({
      approvalMode: "adversarial",
      inferenceProvider: "anthropic",
      anthropicApiKey: ANTHROPIC_KEY,
      relayCredential: PLOW_CREDENTIAL,
    });
    setInferenceProvider(home, "plow");
    expect(stored(home).inferenceProvider).toBe("plow");
    expect(stored(home).approvalMode).toBe("adversarial"); // plow has a credential

    // Now take the Plow credential away and try to come back to it.
    signOutOfPlow(home);
    expect(stored(home).approvalMode).toBe("ask");
  });
});

describe("clearing the active provider's credential persists the fallback to ask", () => {
  it("clearing the Anthropic key while Anthropic is active", () => {
    const home = homeWith({
      approvalMode: "adversarial",
      inferenceProvider: "anthropic",
      anthropicApiKey: ANTHROPIC_KEY,
    });

    setAnthropicApiKey(home, "");

    expect(stored(home).anthropicApiKey).toBe("");
    expect(stored(home).approvalMode).toBe("ask");
  });

  it("a whitespace-only key counts as cleared", () => {
    const home = homeWith({
      approvalMode: "adversarial",
      inferenceProvider: "anthropic",
      anthropicApiKey: ANTHROPIC_KEY,
    });
    setAnthropicApiKey(home, "   ");
    expect(stored(home).anthropicApiKey).toBe("");
    expect(stored(home).approvalMode).toBe("ask");
  });

  it("clearing the INACTIVE provider's key leaves the mode alone", () => {
    // Plow is doing the reviewing; the Anthropic key going away changes nothing
    // about whether the reviewer can run.
    const home = homeWith({
      approvalMode: "adversarial",
      inferenceProvider: "plow",
      relayCredential: PLOW_CREDENTIAL,
      anthropicApiKey: ANTHROPIC_KEY,
    });

    setAnthropicApiKey(home, "");

    expect(stored(home).approvalMode).toBe("adversarial");
  });

  it("storing a key does not resurrect Adversarial mode on its own", () => {
    const home = homeWith({ approvalMode: "ask", inferenceProvider: "anthropic" });
    setAnthropicApiKey(home, ANTHROPIC_KEY);
    expect(stored(home).approvalMode).toBe("ask");
  });
});

describe("Plow sign-out retires Adversarial mode the same way clearing the key does", () => {
  it("forgets the credential and persists mode -> ask", () => {
    const home = homeWith({
      approvalMode: "adversarial",
      inferenceProvider: "plow",
      relayCredential: PLOW_CREDENTIAL,
      accountUid: "u_someone",
      mcpUrl: "https://api.plow.co/v1/relay/devices/u_someone/mcp",
    });

    signOutOfPlow(home);

    const after = stored(home);
    expect(after.relayCredential).toBe("");
    expect(after.accountUid).toBe("");
    expect(after.mcpUrl).toBe("");
    expect(after.approvalMode).toBe("ask");
  });

  it("signing out while Anthropic is the reviewer leaves the mode alone", () => {
    const home = homeWith({
      approvalMode: "adversarial",
      inferenceProvider: "anthropic",
      anthropicApiKey: ANTHROPIC_KEY,
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

describe("selecting Adversarial mode is refused when no reviewer can run", () => {
  it("falls back to ask rather than storing a mode nothing can serve", () => {
    const home = homeWith({ approvalMode: "ask", inferenceProvider: "plow", relayCredential: "" });
    expect(setApprovalMode(home, "adversarial")).toBe("ask");
    expect(stored(home).approvalMode).toBe("ask");
  });

  it("accepts it when the active provider has a credential", () => {
    const home = homeWith({ inferenceProvider: "plow", relayCredential: PLOW_CREDENTIAL });
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
  it("stays owner-only after every action writes it", () => {
    const home = homeWith({ relayCredential: PLOW_CREDENTIAL, anthropicApiKey: ANTHROPIC_KEY });
    const file = path.join(home, "app/settings.json");
    for (const act of [
      () => setInferenceProvider(home, "anthropic"),
      () => setAnthropicApiKey(home, ANTHROPIC_KEY),
      () => setApprovalMode(home, "ask"),
      () => signOutOfPlow(home),
    ]) {
      act();
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("what the renderer is handed never contains either credential", () => {
    const home = homeWith({ relayCredential: PLOW_CREDENTIAL, anthropicApiKey: ANTHROPIC_KEY });
    const serialized = JSON.stringify([
      readInference(home),
      setInferenceProvider(home, "anthropic"),
      setInferenceProvider(home, "nonsense"),
    ]);
    expect(serialized).not.toContain(PLOW_CREDENTIAL);
    expect(serialized).not.toContain(ANTHROPIC_KEY);
    expect(serialized).not.toContain(PLOW_CREDENTIAL.slice(0, 10));
    expect(serialized).not.toContain(ANTHROPIC_KEY.slice(0, 10));
  });
});

describe("signing out retires the credential server-side, best effort", () => {
  const homeSignedIn = () =>
    homeWith({
      relayCredential: PLOW_CREDENTIAL,
      accountUid: "u_someone",
      mcpUrl: "https://api.plow.co/v1/relay/devices/u_someone/mcp",
      approvalMode: "adversarial",
      inferenceProvider: "plow",
    });

  it("asks Plow to revoke, using the credential being retired", async () => {
    const home = homeSignedIn();
    const seen: string[] = [];
    // Observed inside the callback, asserted OUTSIDE it. An expect() in there
    // would be swallowed by the best-effort catch this very function relies on,
    // and the test would pass with the ordering reversed.
    let onDiskWhenAsked: string | null = null;

    await revokeAndSignOut(home, async (credential) => {
      seen.push(credential);
      onDiskWhenAsked = stored(home).relayCredential;
    });

    expect(seen).toEqual([PLOW_CREDENTIAL]);
    // The revoke authenticates with the CAPTURED token, so the disk copy is
    // already gone by the time we ask — see the quit test below for why.
    expect(onDiskWhenAsked).toBe("");
    expect(stored(home).relayCredential).toBe("");
  });

  it("the credential is off disk and the socket down BEFORE the revoke is awaited", async () => {
    // The quit-during-revoke window. `app.quit()` does not wait for a pending
    // IPC handler, so anything still awaiting when the user picks Quit simply
    // never happens. With the revoke in front, the process exits holding a
    // spend-capable credential that reconnects on the next launch — the user
    // asked to sign out and, from the app's next boot, never did.
    const home = homeSignedIn();
    let relayStopped = false;

    // A revoke that never settles: exactly what a hung network looks like, and
    // the window a quit lands in.
    const signOut = revokeAndSignOut(
      home,
      () => new Promise(() => {}),
      async () => {
        relayStopped = true;
      },
    );
    // Let everything that does NOT depend on the network run to completion.
    await Promise.race([signOut, Promise.resolve()]);
    await new Promise((r) => setImmediate(r));

    // Quit here and this is the state that survives to the next launch.
    const after = stored(home);
    expect(after.relayCredential).toBe("");
    expect(after.accountUid).toBe("");
    expect(after.mcpUrl).toBe("");
    expect(after.approvalMode).toBe("ask");
    expect(relayStopped).toBe(true);
  });

  it("the revoke is INITIATED even while the relay is still draining", async () => {
    // The third window in this area, and the one the two tests above do not
    // reach: production passes `startRelay` as `afterClear`, and
    // `RelayClient.stop()` deliberately waits for in-flight requests so a
    // shutdown never strands an agent mid-call. Awaiting that before starting
    // the revoke parks the one call that matters behind a drain as long as an
    // agent's slowest tool — and a quit in there means `/self/revoke` never
    // began at all. Nothing that can block arbitrarily long may sit in front
    // of it.
    const home = homeSignedIn();
    const seen: string[] = [];
    let drainStarted = false;
    let signOutSettled = false;

    // A drain that never finishes: an agent mid-call at the moment of sign-out.
    void revokeAndSignOut(
      home,
      async (credential) => {
        seen.push(credential);
      },
      () => {
        drainStarted = true;
        return new Promise(() => {});
      },
    ).then(() => {
      signOutSettled = true;
    });
    await new Promise((r) => setImmediate(r));

    // Quit here — mid-drain — and the revoke has still gone out.
    expect(drainStarted).toBe(true);
    expect(signOutSettled).toBe(false); // still parked on the drain, as it should be
    expect(seen).toEqual([PLOW_CREDENTIAL]);
    expect(stored(home).relayCredential).toBe("");
  });

  it("waits for both the drain and the revoke before it resolves", async () => {
    // Started together, but the caller's promise still covers both: a sign-out
    // that resolved while either was outstanding would report a completion it
    // has no evidence for.
    const home = homeSignedIn();
    let revokeDone = false;
    let drainDone = false;
    let settled = false;

    const signOut = revokeAndSignOut(
      home,
      () =>
        new Promise((r) => {
          setTimeout(() => {
            revokeDone = true;
            r(null);
          }, 20);
        }),
      () =>
        new Promise((r) => {
          setTimeout(() => {
            drainDone = true;
            r(null);
          }, 40);
        }),
    ).then(() => {
      settled = true;
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(revokeDone).toBe(true);
    expect(drainDone).toBe(false);
    expect(settled).toBe(false); // the drain is still out

    await signOut;
    expect(drainDone).toBe(true);
    expect(settled).toBe(true);
  });

  it("a drain that THROWS does not take the revoke down with it", async () => {
    const home = homeSignedIn();
    const seen: string[] = [];

    await expect(
      revokeAndSignOut(
        home,
        async (credential) => {
          seen.push(credential);
        },
        () => {
          throw new Error("relay stop blew up");
        },
      ),
    ).resolves.toBeUndefined();

    expect(seen).toEqual([PLOW_CREDENTIAL]);
    expect(stored(home).relayCredential).toBe("");
  });

  it("clears locally even when the revoke FAILS", async () => {
    // Offline, API down, route not deployed — the case that matters most,
    // because a Mac that cannot reach Plow is the one whose owner most wants
    // the local copy gone.
    const home = homeSignedIn();

    await expect(
      revokeAndSignOut(home, async () => {
        throw new Error("ENOTFOUND api.plow.co");
      }),
    ).resolves.toBeUndefined();

    const after = stored(home);
    expect(after.relayCredential).toBe("");
    expect(after.accountUid).toBe("");
    expect(after.mcpUrl).toBe("");
    // …and the interlock still fires: no credential, no Adversarial mode.
    expect(after.approvalMode).toBe("ask");
  });

  it("clears locally for every shape of failure", async () => {
    for (const fail of [
      () => Promise.reject(new Error("500")),
      () => Promise.reject("a bare string"),
      () => Promise.reject(new PlowApiError("http", "Plow returned 404.", 404)),
      () => {
        throw new Error("threw synchronously");
      },
    ]) {
      const home = homeSignedIn();
      await revokeAndSignOut(home, fail as () => Promise<unknown>);
      expect(stored(home).relayCredential).toBe("");
    }
  });

  it("does not call out at all when there is nothing to revoke", async () => {
    const home = homeWith({ relayCredential: "" });
    const revoke = vi.fn();
    await revokeAndSignOut(home, revoke);
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
