import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((home) => fs.rmSync(home, { recursive: true, force: true })));

function homeWith(settings?: unknown): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "latch-clean-"));
  homes.push(home);
  if (settings !== undefined) {
    fs.mkdirSync(path.join(home, "app"));
    fs.writeFileSync(path.join(home, "app/settings.json"), JSON.stringify(settings));
  }
  return home;
}

function check(home: string): string {
  const result = spawnSync("node", ["scripts/assert-home-cleanable.mjs", home], { encoding: "utf8" });
  return result.status === 0 ? "ok" : result.stderr;
}

describe("home cleanup credential guard", () => {
  it("allows a missing or credential-free settings file", () => {
    expect(check(homeWith())).toBe("ok");
    expect(check(homeWith({ relayCredential: "", pendingRevokeCredentials: [] }))).toBe("ok");
  });

  it.each([
    { relayCredential: "active-secret" },
    { relayCredentialEnc: "active-seal" },
    { pendingRevokeCredentials: ["pending-secret"] },
    { pendingRevokeCredentialsEnc: ["pending-seal"] },
  ])("refuses a home containing active or pending credentials", (settings) => {
    const result = check(homeWith(settings));
    expect(result).toContain("sign out and wait for pending revokes to reach zero");
    expect(result).not.toContain("secret");
    expect(result).not.toContain("seal");
  });
});
