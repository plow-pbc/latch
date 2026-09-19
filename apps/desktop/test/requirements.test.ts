/**
 * The one grant seam: whatever a requirement id names, the act runs it to its
 * end, and only an act that could not be done answers with an error line.
 * Pinned here over a fake Mac: an account id connects that account, Safari's
 * setting refuses to try without Full Disk Access (never touching Safari),
 * and any other id is a permission.
 */
import { describe, expect, it } from "vitest";
import { accountRequirementId, SAFARI_JAVASCRIPT } from "../src/pluginsModel.js";
import { actOnRequirement, type ActResult, type RequirementDeps } from "../src/requirements.js";

/** A Mac where Full Disk Access is (or is not) on, and Safari's write may
 *  fail. `mac` is what the acts leave behind. */
function world(o: { fullDiskAccess?: boolean; safariFails?: string }) {
  const mac = { accounts: [] as string[], permissions: [] as string[], safari: false };
  const deps: RequirementDeps = {
    permission: async (key) => void mac.permissions.push(key),
    connectAccount: async (id) => void mac.accounts.push(id),
    fullDiskAccess: async () => o.fullDiskAccess ?? false,
    enableSafari: async () => {
      if (o.safariFails) throw new Error(o.safariFails);
      mac.safari = true;
    },
  };
  return { deps, mac };
}

const untouched: ReturnType<typeof world>["mac"] = { accounts: [], permissions: [], safari: false };

describe("actOnRequirement", () => {
  it.each<[string, string, Parameters<typeof world>[0], ActResult, typeof untouched]>([
    ["an account", accountRequirementId("google"), {}, { error: null }, { ...untouched, accounts: ["google"] }],
    ["a permission", "accessibility", {}, { error: null }, { ...untouched, permissions: ["accessibility"] }],
    [
      "Safari without Full Disk Access",
      SAFARI_JAVASCRIPT,
      { fullDiskAccess: false },
      { error: "Safari's setting needs Full Disk Access first." },
      untouched,
    ],
    ["Safari with Full Disk Access", SAFARI_JAVASCRIPT, { fullDiskAccess: true }, { error: null }, { ...untouched, safari: true }],
    [
      "Safari's write failing",
      SAFARI_JAVASCRIPT,
      { fullDiskAccess: true, safariFails: "Safari could not be relaunched" },
      { error: "Safari could not be relaunched" },
      untouched,
    ],
  ])("%s", async (_name, id, o, expected, after) => {
    const { deps, mac } = world(o);
    expect(await actOnRequirement(id, deps)).toEqual(expected);
    expect(mac).toEqual(after);
  });
});
