/**
 * settings.json holds a secret — the relay credential — so its permissions are
 * a security property, not housekeeping. It used to be written with no mode at
 * all.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, saveSettings, Settings, useCredentialCodec } from "../src/settings.js";
import { signOutOfPlow } from "../src/settingsActions.js";

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

describe("the credential at rest", () => {
  /** A codec that is obviously not encryption — the point is the SHAPE: one
   * value in the file, decrypted only through the port, never the plaintext. */
  const fakeCodec = (available = true) => ({
    available: () => available,
    encrypt: (plain: string) => `sealed:${Buffer.from(plain).toString("base64")}`,
    decrypt: (cipher: string) => {
      if (!cipher.startsWith("sealed:")) throw new Error("not ours");
      return Buffer.from(cipher.slice("sealed:".length), "base64").toString();
    },
  });

  afterEach(() => useCredentialCodec(null));

  const fileOf = (home: string) =>
    JSON.parse(fs.readFileSync(path.join(home, "app/settings.json"), "utf8")) as Record<string, unknown>;

  /**
   * The two secrets in this file, and how to put values into each and read
   * them back.
   *
   * They are one contract with two spellings — the credential is one value and
   * the held sessions are a list — and the contract, not the spelling, is what
   * these tests are about: sealed on write, never in the clear on disk, back
   * through the port on read, and a plaintext home migrated by the first read
   * that can seal it. Two parallel copies of that is how one of them drifts.
   */
  const secrets = [
    {
      name: "the credential",
      plainKey: "relayCredential",
      sealedKey: "relayCredentialEnc",
      emptyOnDisk: "",
      values: ["plow_sk_secret_value"],
      set: (settings: Settings, values: string[]) => {
        settings.relayCredential = values[0];
      },
      read: (settings: Settings) => (settings.relayCredential ? [settings.relayCredential] : []),
    },
    {
      name: "the sessions held for a later revoke",
      plainKey: "pendingRevocations",
      sealedKey: "pendingRevocationsEnc",
      emptyOnDisk: [] as unknown,
      // Two, because the list is sealed entry by entry rather than as one
      // blob: one unreadable seal has to cost one token, not all of them.
      values: ["plow_sk_to_retire", "plow_sk_also_retire"],
      set: (settings: Settings, values: string[]) => {
        settings.pendingRevocations = [...values];
      },
      read: (settings: Settings) => settings.pendingRevocations,
    },
  ];

  /** Whatever the sealed key holds, as a list — a string for one secret, an
   * array for a list of them. */
  const sealedEntries = (home: string, key: string): unknown[] =>
    [fileOf(home)[key]].flat().filter((entry) => entry !== undefined);

  it.each(secrets)("writes $name sealed and never in the clear", (secret) => {
    useCredentialCodec(fakeCodec());
    const home = tempHome();
    const settings = loadSettings(home);
    secret.set(settings, secret.values);
    saveSettings(home, settings);

    const raw = fs.readFileSync(path.join(home, "app/settings.json"), "utf8");
    for (const value of secret.values) expect(raw).not.toContain(value);
    // One seal per value, and the exact bytes — a seal nobody can check is a
    // seal that could be the plaintext with a prefix on it.
    expect(sealedEntries(home, secret.sealedKey)).toEqual(
      secret.values.map((value) => `sealed:${Buffer.from(value).toString("base64")}`),
    );
    expect(fileOf(home)[secret.plainKey]).toEqual(secret.emptyOnDisk);
    // ...and it comes back through the port.
    expect(secret.read(loadSettings(home))).toEqual(secret.values);
  });

  it.each(secrets)("migrates a plaintext home's $name on the first read that can seal it", (secret) => {
    const home = tempHome();
    const settings = loadSettings(home);
    secret.set(settings, secret.values);
    saveSettings(home, settings);
    // Written in the clear, because no codec was installed yet.
    expect(secret.read(loadSettings(home))).toEqual(secret.values);

    useCredentialCodec(fakeCodec());
    expect(secret.read(loadSettings(home))).toEqual(secret.values);

    // Rewritten on that read, not left for some later unrelated write.
    const raw = fs.readFileSync(path.join(home, "app/settings.json"), "utf8");
    for (const value of secret.values) expect(raw).not.toContain(value);
    expect(sealedEntries(home, secret.sealedKey)).toHaveLength(secret.values.length);
  });

  it("reads an unreadable held session as nothing to retry", () => {
    // A seal nobody can open holds a token nothing can revoke. Reporting the
    // ciphertext would send the server a bearer it has never seen.
    useCredentialCodec(fakeCodec());
    const home = tempHome();
    const settings = loadSettings(home);
    settings.pendingRevocations = ["plow_sk_readable", "plow_sk_to_retire"];
    saveSettings(home, settings);

    const file = path.join(home, "app/settings.json");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const sealedList = onDisk.pendingRevocationsEnc as string[];
    onDisk.pendingRevocationsEnc = [sealedList[0], "garbage-from-another-keychain"];
    fs.writeFileSync(file, JSON.stringify(onDisk));

    // The unreadable entry costs ITSELF and nothing else — the whole point of
    // sealing entry by entry rather than as one blob.
    expect(loadSettings(home).pendingRevocations).toEqual(["plow_sk_readable"]);
  });

  it("falls back to plaintext 0600 when the OS offers no keychain", () => {
    // No regression against what shipped: the file has always been 0600, so an
    // unavailable keychain must not be a Mac that cannot sign in.
    useCredentialCodec(fakeCodec(false));
    const home = tempHome();
    const settings = loadSettings(home);
    settings.relayCredential = "plow_sk_unsealed";
    saveSettings(home, settings);

    expect(fileOf(home).relayCredential).toBe("plow_sk_unsealed");
    expect(fileOf(home).relayCredentialEnc).toBeUndefined();
    expect(fs.statSync(path.join(home, "app/settings.json")).mode & 0o777).toBe(0o600);
    expect(loadSettings(home).relayCredential).toBe("plow_sk_unsealed");
  });

  it("keeps the credential in the clear when sealing THROWS", () => {
    // `available()` saying yes is not a promise that `encryptString` works —
    // the keychain can be locked between the two calls. A throw escaping
    // `saveSettings` wrote nothing at all, and a sign-in that had just spent
    // its one-shot redeem lost the session it was handed, live on the account
    // with no copy anywhere.
    useCredentialCodec({
      available: () => true,
      encrypt: () => {
        throw new Error("keychain locked");
      },
      decrypt: () => "unused",
    });
    const home = tempHome();
    const settings = loadSettings(home);
    settings.relayCredential = "plow_sk_must_survive";
    saveSettings(home, settings);

    expect(fileOf(home).relayCredential).toBe("plow_sk_must_survive");
    expect(fileOf(home).relayCredentialEnc).toBeUndefined();
    expect(fs.statSync(path.join(home, "app/settings.json")).mode & 0o777).toBe(0o600);
    expect(loadSettings(home).relayCredential).toBe("plow_sk_must_survive");
  });

  it("reads an unreadable seal as signed out rather than throwing", () => {
    // A restored backup, or a new login keychain: the entry is gone. "Signed
    // out" sends the owner through setup; a throw sends them nowhere.
    useCredentialCodec(fakeCodec());
    const home = tempHome();
    const settings = loadSettings(home);
    settings.relayCredential = "plow_sk_sealed";
    saveSettings(home, settings);

    const file = path.join(home, "app/settings.json");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    onDisk.relayCredentialEnc = "garbage-from-another-keychain";
    fs.writeFileSync(file, JSON.stringify(onDisk));

    expect(loadSettings(home).relayCredential).toBe("");
  });

  it("keeps a seal it cannot open, through a routine save", () => {
    // THE dangerous one, and an ordinary window move was enough to reach it: a
    // locked keychain made the credential read as `""`, `""` looked exactly
    // like "there is no credential", and the next save deleted the only copy
    // of a live 180-day session. An unread secret is not an absent one.
    useCredentialCodec(fakeCodec());
    const home = tempHome();
    const settings = loadSettings(home);
    settings.relayCredential = "plow_sk_sealed";
    settings.pendingRevocations = ["plow_sk_held"];
    settings.accountUid = "u_first";
    saveSettings(home, settings);
    const sealedCredential = fileOf(home).relayCredentialEnc;
    const sealedHeld = fileOf(home).pendingRevocationsEnc;

    // The keychain goes away — a locked login keychain, a Mac before
    // `app.ready`. Both secrets read as nothing...
    useCredentialCodec(fakeCodec(false));
    const blind = loadSettings(home);
    expect(blind.relayCredential).toBe("");
    expect(blind.pendingRevocations).toEqual([]);

    // ...and then the window gets moved, which saves settings.
    blind.windowBounds = { x: 10, y: 10, width: 900, height: 700 };
    saveSettings(home, blind);

    // The ciphertext is still there, byte for byte.
    expect(fileOf(home).relayCredentialEnc).toBe(sealedCredential);
    expect(fileOf(home).pendingRevocationsEnc).toEqual(sealedHeld);

    // ...and everything comes back when the keychain does.
    useCredentialCodec(fakeCodec());
    const recovered = loadSettings(home);
    expect(recovered.relayCredential).toBe("plow_sk_sealed");
    expect(recovered.pendingRevocations).toEqual(["plow_sk_held"]);
    expect(recovered.accountUid).toBe("u_first");
  });

  it("keeps unopened held sessions when a readable one is added beside them", () => {
    // Half a list readable is the awkward shape: the new token has to be
    // sealed and written WITHOUT dropping the entries this Mac cannot read.
    useCredentialCodec(fakeCodec());
    const home = tempHome();
    const first = loadSettings(home);
    first.pendingRevocations = ["plow_sk_older"];
    saveSettings(home, first);

    const file = path.join(home, "app/settings.json");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const stranger = "sealed-by-another-keychain";
    onDisk.pendingRevocationsEnc = [...(onDisk.pendingRevocationsEnc as string[]), stranger];
    fs.writeFileSync(file, JSON.stringify(onDisk));

    const read = loadSettings(home);
    expect(read.pendingRevocations).toEqual(["plow_sk_older"]);
    read.pendingRevocations = [...read.pendingRevocations, "plow_sk_newer"];
    saveSettings(home, read);

    // The unopened entry survived, and both readable ones are there.
    expect(fileOf(home).pendingRevocationsEnc).toContain(stranger);
    expect(loadSettings(home).pendingRevocations).toEqual(["plow_sk_older", "plow_sk_newer"]);
  });

  it("lets sign-out delete a seal nobody can open", () => {
    // Carrying ciphertext forward must not outlive the sign-out meant to end
    // it, so sign-out clears BOTH spellings explicitly.
    useCredentialCodec(fakeCodec());
    const home = tempHome();
    const settings = loadSettings(home);
    settings.relayCredential = "plow_sk_sealed";
    settings.accountUid = "u_first";
    settings.provisionedChatLabel = "Willow · You";
    saveSettings(home, settings);

    useCredentialCodec(fakeCodec(false));
    signOutOfPlow(home);

    expect(fileOf(home).relayCredentialEnc).toBeUndefined();
    expect(fileOf(home).relayCredential).toBe("");
    expect(fileOf(home).accountUid).toBe("");
    expect(fileOf(home).provisionedChatLabel).toBe("");
  });

  it("does not hand back a sealed credential when no codec is installed", () => {
    // `latch-smoke` and the tests read settings without Electron. Reporting the
    // ciphertext as the credential would put a useless value in a bearer header.
    useCredentialCodec(fakeCodec());
    const home = tempHome();
    const settings = loadSettings(home);
    settings.relayCredential = "plow_sk_sealed";
    saveSettings(home, settings);

    useCredentialCodec(null);
    expect(loadSettings(home).relayCredential).toBe("");
  });
});
