/* Setup's Access run (onboardingGrants.js) over a fake bridge: which grant
   flows the owner is walked through, where a miss stops the run, and what the
   one button says. The act answers with the fresh list, as main's
   requirements:act does; whether a grant landed is read from that list. */
import { describe, expect, it } from "vitest";
import { accessPrimary, openGrants, runGrants } from "../src/renderer/onboardingGrants.js";

interface Grant {
  id: string;
  met: boolean;
  relaunch?: true;
}

const grant = (id: string, over: Partial<Grant> = {}): Grant => ({ id, met: false, ...over });

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
      const next = state.grants.map((g) => (g.id !== id ? g
        : how === "met" ? { ...g, met: true }
        : how === "relaunch" ? { ...g, relaunch: true as const }
        : g));
      return { grants: next, error: how === "miss" ? "Sign-in didn't finish." : null };
    },
    getState: () => state,
    setState: (next: { grants: Grant[] }) => {
      state = next;
    },
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
    ["a grant waiting on a relaunch counts as landed and moves on", [grant("fda"), grant("safari")], { fda: "relaunch" }, [], undefined,
      { missed: null, walked: ["fda", "safari"] }],
    ["a miss stops the run on its row, with the act's error", [grant("fda"), grant("safari"), grant("account:google")], { safari: "miss" }, [], undefined,
      { missed: { id: "safari", error: "Sign-in didn't finish." }, walked: ["fda", "safari"] }],
    ["a throw is a miss with no error of its own", [grant("fda"), grant("safari")], { fda: "throw" }, [], undefined,
      { missed: { id: "fda", error: null }, walked: ["fda"] }],
    ["a skipped grant is not run", [grant("fda"), grant("safari")], {}, ["fda"], undefined,
      { missed: null, walked: ["safari"] }],
    ["met and relaunch-pending grants are not run", [grant("fda", { met: true }), grant("ax", { relaunch: true }), grant("safari")], {}, [], undefined,
      { missed: null, walked: ["safari"] }],
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

it("leaves out what is met, waiting on a relaunch or skipped, in list order", () => {
  const grants = [grant("fda", { met: true }), grant("ax", { relaunch: true }), grant("safari"), grant("contacts"), grant("account:google")];
  expect(openGrants(grants, new Set(["contacts"])).map((g: Grant) => g.id)).toEqual(["safari", "account:google"]);
});

describe("the Access button", () => {
  it.each([
    ["Try again while the miss is still open, ahead of the count",
      { grants: [grant("fda"), grant("safari")], missed: { id: "fda", error: null } }, { label: "Try again", kind: "run" }],
    ["no Try again once the missed grant landed elsewhere",
      { grants: [grant("fda", { met: true }), grant("safari")], missed: { id: "fda", error: null } }, { label: "Set up all 1", kind: "run" }],
    ["no Try again once the missed grant waits on a relaunch",
      { grants: [grant("fda", { relaunch: true })], missed: { id: "fda", error: null } }, { label: "Relaunch to finish", kind: "relaunch" }],
    ["no Try again once the missed grant is skipped",
      { grants: [grant("fda")], skipped: ["fda"], missed: { id: "fda", error: null } }, { label: "Continue", kind: "advance" }],
    ["disabled while a flow runs",
      { grants: [grant("fda"), grant("safari")], running: "fda" }, { label: "Setting up…", kind: null }],
    ["counts what is still open, skipping the skipped",
      { grants: [grant("fda"), grant("safari"), grant("account:google")], skipped: ["safari"] }, { label: "Set up all 2", kind: "run" }],
    ["runs what is open before offering the relaunch",
      { grants: [grant("fda", { relaunch: true }), grant("safari")] }, { label: "Set up all 1", kind: "run" }],
    ["relaunches when a grant waits on it and nothing else is open",
      { grants: [grant("fda", { relaunch: true }), grant("safari", { met: true })] }, { label: "Relaunch to finish", kind: "relaunch" }],
    ["continues when everything is met or skipped",
      { grants: [grant("fda", { met: true }), grant("safari")], skipped: ["safari"] }, { label: "Continue", kind: "advance" }],
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
