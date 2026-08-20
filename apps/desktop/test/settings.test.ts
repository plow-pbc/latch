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
  const write = (home: string, json: string) => {
    const file = path.join(home, "app/settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, json);
  };

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

  /**
   * The two things a load can do to the file meet here. Scrubbing a retired key
   * writes the whole settings object back, so a legacy home that is both
   * signed in and holding a retired key is the case where the grandfathered
   * bit has to already be set when that write happens — otherwise the load
   * hands back `true` and persists `false`, and the NEXT load reads the
   * explicit false and leaves the owner's login item to be flipped by a
   * re-setup.
   */
  it("persists the grandfathered bit when the same load scrubs a retired key", () => {
    const home = tempHome();
    write(
      home,
      JSON.stringify({ relayCredential: "plow_sk_secret", anthropicApiKey: "sk-retired" }),
    );
    expect(loadSettings(home).launchAtLoginDefaulted).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, "app/settings.json"), "utf8"));
    expect(onDisk.launchAtLoginDefaulted).toBe(true);
    expect(onDisk).not.toHaveProperty("anthropicApiKey");
    // And the second load, which finds nothing to scrub, agrees with the first.
    expect(loadSettings(home).launchAtLoginDefaulted).toBe(true);
  });
});
