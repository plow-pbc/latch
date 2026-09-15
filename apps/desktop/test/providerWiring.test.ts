/**
 * The two things this file exists to make testable with no display: which
 * credential leaves this Mac, and what a mint's answer is allowed to say.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMinter } from "../src/providerWiring.js";
import { PlowApi } from "../src/plowApi.js";
import { saveSettings } from "../src/settings.js";
import { providerFor } from "@domo/device-core";

const GOG = providerFor(["plow-gog"])!;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function homeWith(credential: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "latch-provwire-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  saveSettings(home, { relayCredential: credential });
  return home;
}

describe("buildMinter", () => {
  it("reads the credential from home on EVERY call, not once at construction", async () => {
    const home = homeWith("cred-firstfirst");
    const sent: { auth: string; url: string }[] = [];
    const api = new PlowApi("https://api.example.com", async (url, init) => {
      sent.push({
        auth: String((init?.headers as Record<string, string>).authorization),
        url: String(url),
      });
      return new Response(
        JSON.stringify({
          data: { accounts: [{ account: "a@example.com", access_token: "ya29.token-value-here", is_default: true }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const minter = buildMinter({ api, home });

    await minter.mintAll(GOG);
    // The route comes from the provider's registry row — both halves literals.
    expect(sent[0]!.url).toBe("https://api.example.com/v1/connectors/gmail/access-token");
    // Re-pairing takes effect on the next command, not the next launch; a
    // captured credential keeps sending a stale one until the app relaunches,
    // which reads as a server problem rather than a not-yet-re-paired Mac.
    saveSettings(home, { relayCredential: "cred-secondsecond" });
    await minter.mintAll(GOG);
    expect(sent.map((c) => c.auth)).toEqual(["Bearer cred-firstfirst", "Bearer cred-secondsecond"]);
  });

  /** A PlowApi whose fetch records each request and answers with `body`. */
  function apiAnswering(body: unknown, requests: { url: string; body: unknown }[] = []) {
    const api = new PlowApi("https://api.example.com", async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    return { api, requests };
  }

  describe("mintAll", () => {
    const BATCH = {
      data: {
        access_token: "tok-default",
        accounts: [
          { account: "a@example.com", access_token: "tok-a", is_default: true },
          { account: "b@example.com", access_token: "tok-b", is_default: false },
        ],
        degraded: [
          { account: "c@example.com", reason: "needs_reauth" },
          // Server-authored, off the allowlist: the reason reaches the remote
          // agent, so anything but the machine value becomes fixed local text
          // — the credential-echo rule at the one seam the response crosses.
          { account: "d@example.com", reason: "refresh failed: Bearer sk-secret-fragment" },
        ],
      },
    };

    it("posts {all: true} to the provider's mint route and maps every account", async () => {
      const requests: { url: string; body: unknown }[] = [];
      const { api } = apiAnswering(BATCH, requests);
      const minted = await buildMinter({ api, home: homeWith("cred") }).mintAll(GOG);
      expect(requests).toEqual([
        { url: "https://api.example.com/v1/connectors/gmail/access-token", body: { all: true } },
      ]);
      expect(minted).toEqual({
        accounts: [
          { account: "a@example.com", token: "tok-a", isDefault: true },
          { account: "b@example.com", token: "tok-b", isDefault: false },
        ],
        degraded: [
          { account: "c@example.com", reason: "needs_reauth" },
          { account: "d@example.com", reason: "token refresh failed" },
        ],
      });
    });

    it("turns every malformed row into a fixed degraded entry, echoing nothing", async () => {
      // The complete boundary parse: a named-but-tokenless row degrades under
      // its (validated) email; a row whose account is not a plausible email —
      // credential-shaped or free text — degrades under a FIXED label, so no
      // server-authored string rides the account field to the agent.
      const { api } = apiAnswering({
        data: {
          access_token: "tok-a",
          accounts: [
            { account: "a@example.com", access_token: "tok-a", is_default: true },
            { account: "broken@example.com" }, // named, no token
            { account: "Bearer sk-fragment-abc123", access_token: "tok-x" }, // not an email
            // A "token" carrying the request's own bearer credential is the
            // credential echoed back, not a mint.
            { account: "echo@example.com", access_token: "echo-cred-echo" },
          ],
          degraded: [{ account: "error: sk-fragment-def456 rejected", reason: "boom" }],
        },
      });
      const minted = await buildMinter({ api, home: homeWith("cred") }).mintAll(GOG);
      expect(minted).toEqual({
        accounts: [{ account: "a@example.com", token: "tok-a", isDefault: true }],
        degraded: [
          { account: "broken@example.com", reason: "token refresh failed" },
          { account: "(unrecognized account)", reason: "malformed entry" },
          { account: "echo@example.com", reason: "malformed entry" },
          { account: "(unrecognized account)", reason: "malformed entry" },
        ],
      });
      expect(JSON.stringify(minted)).not.toContain("sk-fragment");
      expect(JSON.stringify(minted)).not.toContain("echo-cred-echo");
    });

    it("returns a degraded-only envelope as a valid answer, not a throw", async () => {
      // "Every account needs re-auth" is an answer the caller must be able to
      // relay; only an envelope with nothing in it reports a failed mint.
      const { api } = apiAnswering({
        data: {
          access_token: "",
          accounts: [],
          degraded: [{ account: "a@example.com", reason: "needs_reauth" }],
        },
      });
      const minted = await buildMinter({ api, home: homeWith("cred") }).mintAll(GOG);
      expect(minted).toEqual({
        accounts: [],
        degraded: [{ account: "a@example.com", reason: "needs_reauth" }],
      });
    });

    it("fails like the single mint when the envelope is empty", async () => {
      const { api } = apiAnswering({ data: { access_token: "tok", accounts: [] } });
      await expect(buildMinter({ api, home: homeWith("cred") }).mintAll(GOG)).rejects.toThrow(
        /usable provider token/,
      );
    });

    it("refuses before calling when this Mac is not paired", async () => {
      let called = false;
      const api = new PlowApi("https://api.example.com", async () => {
        called = true;
        return new Response("{}", { status: 200 });
      });
      await expect(buildMinter({ api, home: homeWith("") }).mintAll(GOG)).rejects.toThrow(/not paired/);
      expect(called).toBe(false);
    });
  });
});
