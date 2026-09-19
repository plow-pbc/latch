/* Setup's Access run (onboardingGrants.js) over a fake bridge: which grant
   flows the owner is walked through, where a miss stops the run, and what the
   one button says. The act shows the fresh list and answers with it, as
   onboarding.js's does over main's requirements:act; whether a grant landed
   is read from that answer. */
import { describe, expect, it } from "vitest";
import { accessPrimary, runGrants } from "../src/renderer/onboardingGrants.js";

interface Grant {
  id: string;
  status: "open" | "met" | "relaunch";
}

const grant = (id: string, status: Grant["status"] = "open"): Grant => ({ id, status });

type Outcome = "met" | "relaunch" | "miss" | "throw";

/** A bridge whose act lands each id as scripted (default: met). `leaveOn`
 *  is the id whose flow the owner walks away from (Back, a sign-out). */
function run(grants: Grant[], outcomes: Record<string, Outcome> = {}, skipped: string[] = [], leaveOn?: string) {
  let state = { grants };
  let here = true;
  let running: string | null = null;
  const walked: string[] = [];
  const runningDuringAct: (string | null)[] = [];
  const missed = runGrants({
    act: async (id: string) => {
      walked.push(id);
      runningDuringAct.push(running);
      if (id === leaveOn) here = false;
      const how = outcomes[id] ?? "met";
      if (how === "throw") throw new Error("the bridge went away");
      state = { grants: state.grants.map((g) => (g.id !== id || how === "miss" ? g : { ...g, status: how })) };
      return { ...state, error: how === "miss" ? "Sign-in didn't finish." : null };
    },
    getState: () => state,
    stillHere: () => here,
    setRunning: (id: string | null) => {
      running = id;
    },
  }, new Set(skipped));
  return missed.then((result: unknown) => ({ missed: result, walked, runningDuringAct, runningAfter: running }));
}

describe("the Access run", () => {
  it.each([
    ["a grant that lands moves on to the next", [grant("fda"), grant("safari")], {}, [], undefined,
      { missed: null, walked: ["fda", "safari"] }],
    // A child can't use the grant until the relaunch, so Safari's write would fail.
    ["a grant that lands waiting on a relaunch ends the run there", [grant("fda"), grant("safari")], { fda: "relaunch" }, [], undefined,
      { missed: null, walked: ["fda"] }],
    ["a miss stops the run on its row, with the act's error", [grant("fda"), grant("safari"), grant("account:google")], { safari: "miss" }, [], undefined,
      { missed: { id: "safari", error: "Sign-in didn't finish." }, walked: ["fda", "safari"] }],
    ["a throw is a miss with no error of its own", [grant("fda"), grant("safari")], { fda: "throw" }, [], undefined,
      { missed: { id: "fda", error: null }, walked: ["fda"] }],
    ["a skipped grant is not run", [grant("fda"), grant("safari")], {}, ["fda"], undefined,
      { missed: null, walked: ["safari"] }],
    ["a met grant is not run", [grant("fda", "met"), grant("safari")], {}, [], undefined,
      { missed: null, walked: ["safari"] }],
    ["nothing runs while a grant waits on a relaunch", [grant("fda", "relaunch"), grant("safari")], {}, [], undefined,
      { missed: null, walked: [] }],
    ["leaving the step stops the run, even on a miss", [grant("fda"), grant("safari")], { fda: "miss" }, [], "fda",
      { missed: null, walked: ["fda"] }],
  ] as const)("%s", async (_name, grants, outcomes, skipped, leaveOn, expected) => {
    const result = await run([...grants], outcomes, [...skipped], leaveOn);
    expect({ missed: result.missed, walked: result.walked }).toEqual(expected);
    // The row that shows the live line is the one whose flow is open, and
    // nothing reads as running once the run ends.
    expect(result.runningDuringAct).toEqual(expected.walked);
    expect(result.runningAfter).toBeNull();
  });
});

describe("the Access button", () => {
  it.each([
    ["Try again while the miss is still open, ahead of the count",
      { grants: [grant("fda"), grant("safari")], missed: { id: "fda", error: null } }, { label: "Try again", kind: "run" }],
    ["no Try again once the missed grant landed elsewhere",
      { grants: [grant("fda", "met"), grant("safari")], missed: { id: "fda", error: null } }, { label: "Set up all 1", kind: "run" }],
    ["relaunches ahead of Try again: the miss waits for it",
      { grants: [grant("fda", "relaunch"), grant("safari")], missed: { id: "safari", error: null } }, { label: "Relaunch to finish", kind: "relaunch" }],
    ["no Try again once the missed grant is skipped",
      { grants: [grant("fda")], skipped: ["fda"], missed: { id: "fda", error: null } }, { label: "Continue", kind: "advance" }],
    ["disabled while a flow runs, even with a relaunch waiting",
      { grants: [grant("fda", "relaunch"), grant("safari")], running: "safari" }, { label: "Setting up…", kind: null }],
    ["counts what is still open, skipping the skipped",
      { grants: [grant("fda"), grant("safari"), grant("account:google")], skipped: ["safari"] }, { label: "Set up all 2", kind: "run" }],
    ["relaunches ahead of the count when a grant waits on it",
      { grants: [grant("fda", "relaunch"), grant("safari")] }, { label: "Relaunch to finish", kind: "relaunch" }],
    ["continues when everything is met or skipped",
      { grants: [grant("fda", "met"), grant("safari")], skipped: ["safari"] }, { label: "Continue", kind: "advance" }],
    ["continues when there is nothing to grant", { grants: [] }, { label: "Continue", kind: "advance" }],
  ] as const)("%s", (_name, input, expected) => {
    const { grants, skipped = [], running = null, missed = null } = input as {
      grants: Grant[];
      skipped?: string[];
      running?: string | null;
      missed?: { id: string; error: string | null } | null;
    };
    expect(accessPrimary({ grants, skipped: new Set(skipped), running, missed })).toEqual(expected);
  });
});
