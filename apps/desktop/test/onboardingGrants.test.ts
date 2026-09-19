/* Setup's Access run (onboardingGrants.js) over a fake bridge: which grant
   flows the owner is walked through, where a miss stops the run, and what the
   one button says. The act shows the fresh list and answers with it, as
   onboarding.js's does over main's requirements:act; whether a grant landed
   is read from that answer. */
import { describe, expect, it } from "vitest";
import { ACTION_IGNORED, accessPrimary, actionMiss, clearMissed, grantAction, runGrants } from "../src/renderer/onboardingGrants.js";

interface Grant {
  id: string;
  status: "open" | "met" | "relaunch";
}

const grant = (id: string, status: Grant["status"] = "open"): Grant => ({ id, status });

/** "warn": the grant lands, but the act still has something to say. */
type Outcome = "met" | "relaunch" | "miss" | "warn" | "throw";

/** A bridge whose act lands each id as scripted (default: met). `leaveOn`
 *  is the id whose flow the owner walks away from (Back, a sign-out). */
function run(grants: Grant[], outcomes: Record<string, Outcome> = {}, skipped: string[] = [], leaveOn?: string) {
  let state = { grants };
  let here = true;
  let running: string | null = null;
  const walked: string[] = [];
  const runningDuringAct: (string | null)[] = [];
  const act = grantAction({
    act: async (id: string) => {
      walked.push(id);
      runningDuringAct.push(running);
      if (id === leaveOn) here = false;
      const how = outcomes[id] ?? "met";
      if (how === "throw") throw new Error("the bridge went away");
      const status = how === "warn" ? "met" : how;
      state = { grants: state.grants.map((g) => (g.id !== id || status === "miss" ? g : { ...g, status })) };
      const error = { miss: "Sign-in didn't finish.", warn: "Safari did not relaunch — open it yourself." }[how as string] ?? null;
      return { ...state, error };
    },
    setRunning: (id: string | null) => {
      running = id;
    },
  });
  const missed = runGrants({
    act,
    getState: () => state,
    stillHere: () => here,
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
    ["a grant that lands with an error stops the run there, so the owner reads it", [grant("safari"), grant("account:google")], { safari: "warn" }, [], undefined,
      { missed: { id: "safari", error: "Safari did not relaunch — open it yourself." }, walked: ["safari"] }],
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

describe("an individual Access action", () => {
  it("runs a met requirement's repeat action once without walking other open grants", async () => {
    const acted: string[] = [];
    const running: Array<string | null> = [];
    const act = grantAction({
      act: async (id: string) => {
        acted.push(id);
        return { grants: [grant("fda"), grant("account:google", "met")], error: null };
      },
      setRunning: (id: string | null) => running.push(id),
    });
    const result = await act("account:google");

    expect(result).toEqual({ grants: [grant("fda"), grant("account:google", "met")], error: null });
    expect(acted).toEqual(["account:google"]);
    expect(running).toEqual(["account:google", null]);
  });

  it.each([
    ["a repeated click", "account:google"],
    ["another row's repeat click", "account:calendar"],
  ])("ignores %s while the first action is pending", async (_name, secondId) => {
    const acted: string[] = [];
    const running: Array<string | null> = [];
    let finish!: (result: { grants: Grant[]; error: null }) => void;
    const act = grantAction({
      act: (id: string) => {
        acted.push(id);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      setRunning: (id: string | null) => running.push(id),
    });

    const first = act("account:google");
    const repeated = await act(secondId);

    expect(acted).toEqual(["account:google"]);
    expect(running).toEqual(["account:google"]);
    expect(repeated).toBe(ACTION_IGNORED);

    finish({ grants: [grant("fda"), grant("account:google", "met")], error: null });
    await expect(first).resolves.toEqual({ grants: [grant("fda"), grant("account:google", "met")], error: null });
    expect(running).toEqual(["account:google", null]);
  });
});

describe("an individual action result", () => {
  it.each([
    ["returned failure", { grants: [grant("account:google", "met")], error: "Sign-in didn't finish." }, { id: "account:google", error: "Sign-in didn't finish." }],
    ["thrown or missing result", null, { id: "account:google", error: null }],
    ["ignored pending action", ACTION_IGNORED, null],
    ["undefined bridge result", undefined, { id: "account:google", error: null }],
    ["successful repeat", { grants: [grant("account:google", "met")], error: null }, null],
  ])("keeps a repeat row actionable after a %s", (_name, result, expected) => {
    expect(actionMiss("account:google", result)).toEqual(expected);
  });
});

describe("a refreshed Access list", () => {
  it("clears a transient miss once its requirement is no longer open", () => {
    const missed = { id: "account:google", error: "Sign-in didn't finish." };

    expect(clearMissed(missed, [grant("fda"), grant("account:google", "met")])).toBeNull();
    expect(clearMissed(missed, [grant("fda"), grant("account:google")])).toEqual(missed);
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
