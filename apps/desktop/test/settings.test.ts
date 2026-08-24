/**
 * settings.json holds a secret — the relay credential — so its permissions are
 * a security property, not housekeeping. It used to be written with no mode at
 * all.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, saveSettings } from "../src/settings.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-settings-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const mode = (file: string) => fs.statSync(file).mode & 0o777;

/** A settings.json written by hand, to stand in for a home from an older build. */
function write(home: string, json: string): void {
  const file = path.join(home, "app/settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, json);
}

describe("settings storage", () => {
  it("writes the file owner-only", () => {
    const home = tempHome();
    const settings = loadSettings(home);
    settings.relayCredential = "plow_sk_secret";
    saveSettings(home, settings);
    const file = path.join(home, "app/settings.json");
    expect(mode(file)).toBe(0o600);
  });

  it("repairs the permissions of a file that predates the change", () => {
    const home = tempHome();
    const file = path.join(home, "app/settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}\n");
    fs.chmodSync(file, 0o644); // world-readable, as it used to be
    expect(mode(file)).toBe(0o644);

    const settings = loadSettings(home);
    settings.relayCredential = "plow_sk_secret";
    saveSettings(home, settings);
    expect(mode(file)).toBe(0o600);
  });

  it("round-trips the credential and what the server said about the account", () => {
    const home = tempHome();
    const settings = loadSettings(home);
    expect(settings.relayCredential).toBe("");
    expect(settings.accountUid).toBe("");
    expect(settings.mcpUrl).toBe("");
    settings.relayCredential = "plow_sk_secret";
    settings.accountUid = "u_123";
    settings.mcpUrl = "https://api.plow.co/v1/relay/devices/u_123/mcp";
    saveSettings(home, settings);
    const reloaded = loadSettings(home);
    expect(reloaded.relayCredential).toBe("plow_sk_secret");
    expect(reloaded.accountUid).toBe("u_123");
    expect(reloaded.mcpUrl).toBe("https://api.plow.co/v1/relay/devices/u_123/mcp");
  });

  /**
   * The default tab is the first launch's landing, and only that. Everything in
   * this app is unreachable until a client can talk to this Mac, so a new home
   * opens on Agents — and an existing one must not be dragged there, because
   * the tab someone left the app on is theirs, not ours.
   */
  it("lands a new home on the Agents tab", () => {
    expect(loadSettings(tempHome()).selectedTab).toBe("agents");
  });

  it("leaves a home that already chose a tab exactly where it was", () => {
    const home = tempHome();
    const settings = loadSettings(home);
    settings.selectedTab = "audit";
    saveSettings(home, settings);
    expect(loadSettings(home).selectedTab).toBe("audit");
  });

  /** The one case that is NOT "keep what you chose": a file written before the
   * field existed has nothing to keep, so it takes the new default. */
  it("gives a settings file that predates the field the new default", () => {
    const home = tempHome();
    const file = path.join(home, "app/settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ relayCredential: "plow_sk_secret" }));
    const settings = loadSettings(home);
    expect(settings.selectedTab).toBe("agents");
    expect(settings.relayCredential).toBe("plow_sk_secret");
  });

  /**
   * The purpose statement is the one field here that a human writes in prose,
   * and the reviewer is told to trust it. A home that has never been told
   * anything must say exactly that — empty, never a seeded sentence someone
   * did not write.
   */
  it("starts with no agent purpose, and round-trips what the owner writes", () => {
    const home = tempHome();
    expect(loadSettings(home).agentPurpose).toBe("");

    const settings = loadSettings(home);
    settings.agentPurpose = "Groceries and calendar only.\nNever touch ~/Developer.";
    saveSettings(home, settings);

    expect(loadSettings(home).agentPurpose).toBe(
      "Groceries and calendar only.\nNever touch ~/Developer.",
    );
  });

  it("gives a settings file written before the purpose existed the empty default", () => {
    const home = tempHome();
    const file = path.join(home, "app/settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ relayCredential: "plow_sk_secret" }));
    expect(loadSettings(home).agentPurpose).toBe("");
  });

  it("no longer carries a connection string or a certificate pin", () => {
    const home = tempHome();
    const settings = loadSettings(home);
    expect(settings).not.toHaveProperty("brokerConnection");
    expect(JSON.stringify(settings)).not.toMatch(/pin/i);
    saveSettings(home, settings);
    const onDisk = fs.readFileSync(path.join(home, "app/settings.json"), "utf8");
    expect(onDisk).not.toMatch(/brokerConnection|domo1\.|pin/i);
  });
});

describe("the launch-at-login first-run marker", () => {
  it("grandfathers a signed-in home from before the field existed", () => {
    const home = tempHome();
    write(home, JSON.stringify({ relayCredential: "plow_sk_secret" }));
    expect(loadSettings(home).launchAtLoginDefaulted).toBe(true);
  });

  it("leaves a signed-out legacy home un-defaulted — its first run is still ahead", () => {
    const home = tempHome();
    write(home, JSON.stringify({ selectedTab: "audit" }));
    expect(loadSettings(home).launchAtLoginDefaulted).toBe(false);
  });

  it("never overrides an explicit false — a fresh setup writes the key and owns it", () => {
    const home = tempHome();
    write(
      home,
      JSON.stringify({ relayCredential: "plow_sk_secret", launchAtLoginDefaulted: false }),
    );
    expect(loadSettings(home).launchAtLoginDefaulted).toBe(false);
  });

  it("starts false in a brand-new home", () => {
    expect(loadSettings(tempHome()).launchAtLoginDefaulted).toBe(false);
  });

});

/**
 * A Mac that once pasted an Anthropic key kept it in settings.json: unknown
 * keys ride the load/save spread straight back to disk, so the secret would
 * outlive the feature by exactly as long as the file does.
 *
 * One home covers the whole contract, because the two halves are one event: the
 * write that removes the secret is the write that persists everything else the
 * load decided. Split across two homes, nothing holds the order between them.
 */
describe("the retired bring-your-own-key fields are scrubbed on read", () => {
  const RETIRED_KEY = "sk-ant-do-not-leak-me";

  it("takes them off disk on load, keeps what survives, and persists the grandfathered bit", () => {
    const home = tempHome();
    write(
      home,
      JSON.stringify({
        relayCredential: "plow_sk_secret",
        approvalMode: "adversarial",
        anthropicApiKey: RETIRED_KEY,
        inferenceProvider: "anthropic",
      }),
    );

    const loaded = loadSettings(home) as unknown as Record<string, unknown>;

    // Nothing that is loaded carries them…
    expect(loaded).not.toHaveProperty("anthropicApiKey");
    expect(loaded).not.toHaveProperty("inferenceProvider");
    expect(JSON.stringify(loaded)).not.toContain(RETIRED_KEY);
    // …the scrub took nothing else with it…
    expect(loaded).toMatchObject({
      approvalMode: "adversarial",
      relayCredential: "plow_sk_secret",
    });
    // …and that read alone took them off disk. Not "the next write of some
    // other setting": a secret nobody reads is still a secret in a file.
    const raw = fs.readFileSync(path.join(home, "app/settings.json"), "utf8");
    expect(raw).not.toContain(RETIRED_KEY);
    expect(raw).not.toContain("anthropicApiKey");
    expect(raw).not.toContain("inferenceProvider");

    // The ordering the same write pins: this legacy home is signed in, so the
    // launch-at-login bit is grandfathered on this load — and it has to already
    // be set when the scrub writes, or the load hands back `true` and persists
    // `false`, and the NEXT load reads the explicit false and leaves the
    // owner's login item to be flipped by a re-setup.
    expect(loaded.launchAtLoginDefaulted).toBe(true);
    expect(JSON.parse(raw).launchAtLoginDefaulted).toBe(true);
    // The second load, which finds nothing to scrub, agrees with the first.
    expect(loadSettings(home).launchAtLoginDefaulted).toBe(true);
  });
});

describe("per-cloud-agent settings", () => {
  it("defaults to an empty map on a home that has never had one", () => {
    expect(loadSettings(tempHome()).cloudAgentSettings).toEqual({});
  });

  it("round-trips a choice keyed on the agent id", () => {
    const home = tempHome();
    const settings = loadSettings(home);
    settings.cloudAgentSettings.agent_1 = { adversarialReview: true };
    saveSettings(home, settings);

    expect(loadSettings(home).cloudAgentSettings).toEqual({
      agent_1: { adversarialReview: true },
    });
  });

  it("survives a home written before the field existed", () => {
    const home = tempHome();
    write(home, JSON.stringify({ relayCredential: "plow_sk_secret", approvalMode: "ask" }));

    expect(loadSettings(home).cloudAgentSettings).toEqual({});
  });

  it("keeps a hand-edited file from becoming a crash on the Agents tab", () => {
    const home = tempHome();
    write(
      home,
      JSON.stringify({
        cloudAgentSettings: {
          agent_ok: { adversarialReview: true },
          agent_loose: { adversarialReview: "yes" },
          agent_null: null,
          agent_scalar: 7,
        },
      }),
    );

    expect(loadSettings(home).cloudAgentSettings).toEqual({
      agent_ok: { adversarialReview: true },
      // Anything that is not the boolean it claims to be reads as off.
      agent_loose: { adversarialReview: false },
    });
  });

  it("reads a non-object in the field as no settings at all", () => {
    const home = tempHome();
    write(home, JSON.stringify({ cloudAgentSettings: null }));
    expect(loadSettings(home).cloudAgentSettings).toEqual({});

    write(home, JSON.stringify({ cloudAgentSettings: ["agent_1"] }));
    expect(loadSettings(home).cloudAgentSettings).toEqual({});
  });
});

describe("the activation's assigned number", () => {
  it("is empty until an activation has told us one", () => {
    expect(loadSettings(tempHome()).activationSendTo).toBe("");
  });

  it("round-trips the server's number verbatim", () => {
    const home = tempHome();
    const settings = loadSettings(home);
    settings.activationSendTo = "+14155550188";
    saveSettings(home, settings);

    expect(loadSettings(home).activationSendTo).toBe("+14155550188");
  });

  it("stays empty on a home that activated before it was kept", () => {
    const home = tempHome();
    write(home, JSON.stringify({ relayCredential: "plow_sk_secret" }));

    expect(loadSettings(home).activationSendTo).toBe("");
  });
});
