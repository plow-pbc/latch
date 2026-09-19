/**
 * The one grant seam: whatever a requirement id names, the act runs it to its
 * end and answers whether it is met afterwards. Pinned here over fake deps: an
 * account id connects that account, Safari's setting refuses to try without
 * Full Disk Access (never touching Safari), and any other id is a permission.
 */
import { describe, expect, it } from "vitest";
import { accountRequirementId, SAFARI_JAVASCRIPT } from "../src/pluginsModel.js";
import { actOnRequirement, type ActResult, type RequirementDeps } from "../src/requirements.js";

/** A Mac where these accounts connect, these permissions end up granted, and
 *  Full Disk Access is (or is not) on. `safariWritten` is what the fake Safari
 *  write leaves behind. */
function world(o: { connects?: string[]; grants?: string[]; fullDiskAccess?: boolean; safariFails?: string }) {
  const state = { safariWritten: false };
  const deps: RequirementDeps = {
    permission: async (key) => (o.grants ?? []).includes(key),
    connectAccount: async (id) => (o.connects ?? []).includes(id),
    fullDiskAccess: async () => o.fullDiskAccess ?? false,
    enableSafari: async () => {
      if (o.safariFails) throw new Error(o.safariFails);
      state.safariWritten = true;
    },
  };
  return { deps, state };
}

describe("actOnRequirement", () => {
  it.each<[string, string, Parameters<typeof world>[0], ActResult, boolean]>([
    ["an account that connects", accountRequirementId("google"), { connects: ["google"] }, { granted: true, error: null }, false],
    ["an account that does not", accountRequirementId("google"), {}, { granted: false, error: null }, false],
    [
      "Safari without Full Disk Access",
      SAFARI_JAVASCRIPT,
      { fullDiskAccess: false },
      { granted: false, error: "Safari's setting needs Full Disk Access first." },
      false,
    ],
    ["Safari with Full Disk Access", SAFARI_JAVASCRIPT, { fullDiskAccess: true }, { granted: true, error: null }, true],
    [
      "Safari's write failing",
      SAFARI_JAVASCRIPT,
      { fullDiskAccess: true, safariFails: "Safari could not be relaunched" },
      { granted: false, error: "Safari could not be relaunched" },
      false,
    ],
    ["a permission the owner grants", "accessibility", { grants: ["accessibility"] }, { granted: true, error: null }, false],
    ["a permission left off", "full_disk_access", { grants: ["accessibility"] }, { granted: false, error: null }, false],
  ])("%s", async (_name, id, o, expected, safariWritten) => {
    const { deps, state } = world(o);
    expect(await actOnRequirement(id, deps)).toEqual(expected);
    expect(state.safariWritten).toBe(safariWritten);
  });
});
