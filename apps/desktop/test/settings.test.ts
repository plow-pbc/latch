/**
 * settings.json holds secrets — the relay credential and an Anthropic API key —
 * so its permissions are a security property, not housekeeping. It used to be
 * written with no mode at all.
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

  it("holds no API URL at all — the origin is baked into the build", () => {
    const settings = loadSettings(tempHome());
    expect(settings).not.toHaveProperty("relayUrl");
    expect(settings).not.toHaveProperty("apiBaseUrl");
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
