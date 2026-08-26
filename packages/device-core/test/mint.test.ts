/**
 * The module that handles the live credential and decides whether to mint.
 *
 * Its headline guarantee is that nothing coming back is ever quoted — the
 * response carries a token, so a failure names the provider and the status and
 * nothing else. That is the property worth testing; the rest is plumbing.
 */
import { describe, expect, it, vi } from "vitest";
import { makeMinter, MintError } from "../src/providers/mint.js";
import { vendoredProvider } from "../src/providers/registry.js";

const GOG = vendoredProvider(["gog"])!;
const TOKEN = "ya29.a0AfB_byExampleTokenValue0000000000";
const CRED = "plow-credential-value";

const minter = (fetchImpl: Parameters<typeof makeMinter>[0]["fetchImpl"], cred = CRED) =>
  makeMinter({ apiBaseUrl: "https://api.example.com/", credential: () => cred, fetchImpl });

const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

describe("makeMinter", () => {
  it("posts to the provider's own route, with the device credential", async () => {
    let seen: { url: string; auth: string; body: string } | null = null;
    await minter(async (url, init) => {
      seen = {
        url: String(url),
        auth: String((init?.headers as Record<string, string>).Authorization),
        body: String(init?.body),
      };
      return new Response(JSON.stringify({ data: { access_token: TOKEN } }), { status: 200 });
    }).mint(GOG);
    expect(seen!.url).toBe("https://api.example.com/v1/connectors/gmail/access-token");
    expect(seen!.auth).toBe(`Bearer ${CRED}`);
    // No account: Plow resolves the owner's default connected one, so this Mac
    // holds no second copy of a fact the server owns.
    expect(seen!.body).toBe("{}");
  });

  it("returns the token", async () => {
    expect(await minter(ok({ data: { access_token: TOKEN } })).mint(GOG)).toBe(TOKEN);
  });

  it("reads the credential on EVERY call, not once at construction", async () => {
    // Re-pairing has to take effect on the next command, not the next launch.
    const creds = ["first-credential", "second-credential"];
    const sent: string[] = [];
    const m = makeMinter({
      apiBaseUrl: "https://api.example.com",
      credential: () => creds.shift() ?? "",
      fetchImpl: async (_u, init) => {
        sent.push(String((init?.headers as Record<string, string>).Authorization));
        return new Response(JSON.stringify({ data: { access_token: TOKEN } }), { status: 200 });
      },
    });
    await m.mint(GOG);
    await m.mint(GOG);
    expect(sent).toEqual(["Bearer first-credential", "Bearer second-credential"]);
  });

  it("refuses to call at all with no credential", async () => {
    const fetchImpl = vi.fn(ok({}));
    await expect(minter(fetchImpl, "   ").mint(GOG)).rejects.toThrow(/not paired/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-2xx", async () => new Response("nope", { status: 503 }), /Plow returned 503/],
    // A 2xx whose body will not parse is NOT an HTTP-status failure: reporting
    // it as one names the success as the fault and hides the real cause.
    ["a 2xx with an unreadable body", async () => new Response("<html>", { status: 200 }), /could not be read/],
    ["a body carrying no token", ok({ data: {} }), /did not return a usable token/],
    ["a body carrying a blank token", ok({ data: { access_token: "  " } }), /did not return a usable token/],
  ] as const)("reports %s", async (_why, fetchImpl, expected) => {
    await expect(minter(fetchImpl).mint(GOG)).rejects.toThrow(expected);
  });

  it.each([
    ["a timeout", { name: "TimeoutError" }, /did not answer in time/],
    ["an abort", { name: "AbortError" }, /did not answer in time/],
    ["an unreachable host", new TypeError("fetch failed"), /could not reach Plow/],
  ] as const)("tells %s apart, since the two send someone to fix different things", async (_w, err, expected) => {
    await expect(
      minter(async () => {
        throw err;
      }).mint(GOG),
    ).rejects.toThrow(expected);
  });

  it("never quotes the response, the credential or the parser into a message", async () => {
    // The one property this module exists to hold: every message is built here
    // from a fixed vocabulary, so a body that echoes a credential cannot reach
    // an audit line or the approval dialog through an error.
    const bodies = [
      new Response(`{"echo":"Bearer ${CRED}","token":"${TOKEN}"}`, { status: 500 }),
      new Response(`Bearer ${CRED}`, { status: 200 }),
    ];
    for (const body of bodies) {
      const error = await minter(async () => body)
        .mint(GOG)
        .then(
          () => null,
          (e: unknown) => e as Error,
        );
      expect(error).toBeInstanceOf(MintError);
      expect(error!.message).not.toContain(CRED);
      expect(error!.message).not.toContain(TOKEN);
    }
  });

});
