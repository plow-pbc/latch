/**
 * What the broker actually receives in its environment.
 *
 * The vault account does not exist when the broker is constructed — it is
 * created by the vault's first run — so anything captured at construction is
 * captured empty. These tests run the broker against a fake that reports its
 * own environment back, which is the only way to see what really arrived.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialBroker, withoutVaultSecrets } from "@domo/device-core";

/** A stand-in broker that answers `whats-here` with its own environment. */
function echoBroker(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-echo-"));
  const file = path.join(dir, "echo.cjs");
  fs.writeFileSync(
    file,
    `process.stdout.write(JSON.stringify([{
      id: process.env.SEED_VAULT_USER ?? "",
      title: process.env.SEED_VAULT_PASSWORD ?? "",
      username: process.env.SEED_VAULT_TOKEN ?? "",
      category: "LOGIN", urls: [], matches_this_page: false,
    }]));
    `,
  );
  return file;
}

describe("what the broker is given", () => {
  it("gets the account created after it was constructed, not an empty one", async () => {
    // The account appears later, exactly as it does on a first run.
    let account: { email: string; password: string } | null = null;
    const broker = new CredentialBroker({
      command: ["node", echoBroker()],
      envFor: () => ({
        SEED_VAULT_USER: account?.email ?? "",
        SEED_VAULT_PASSWORD: account?.password ?? "",
      }),
    });

    const before = await broker.whatsHere("https://example.com");
    expect(before[0].id, "no account yet, so nothing to pass").toBe("");

    account = { email: "someone@local", password: "the-real-password" };

    const after = await broker.whatsHere("https://example.com");
    expect(after[0].id).toBe("someone@local");
    expect(after[0].title).toBe("the-real-password");
  });

  it("hands the bootstrap token to the broker, and to nothing that outlives it", async () => {
    const broker = new CredentialBroker({
      command: ["node", echoBroker()],
      fleetToken: "the-fleet-token",
    });
    const items = await broker.whatsHere("https://example.com");
    expect(items[0].username, "the broker is what the token is for").toBe("the-fleet-token");

    // The browser server and the vault are long-lived and inherit the
    // environment; a compromise of either must not hand over vault bootstrap.
    const stripped = withoutVaultSecrets({
      DOMO_VAULT_TOKEN: "the-fleet-token",
      SEED_VAULT_TOKEN: "the-fleet-token",
      PATH: "/usr/bin",
    });
    expect(stripped.DOMO_VAULT_TOKEN).toBeUndefined();
    expect(stripped.SEED_VAULT_TOKEN).toBeUndefined();
    expect(stripped.PATH, "everything else still travels").toBe("/usr/bin");
  });

  it("still passes a fixed env, for callers that have one", async () => {
    const broker = new CredentialBroker({
      command: ["node", echoBroker()],
      env: { SEED_VAULT_USER: "fixed@local", SEED_VAULT_PASSWORD: "fixed-secret" },
    });
    const items = await broker.whatsHere("https://example.com");
    expect(items[0].id).toBe("fixed@local");
    expect(items[0].title).toBe("fixed-secret");
  });
});
