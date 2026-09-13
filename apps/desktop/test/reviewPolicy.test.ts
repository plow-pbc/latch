/**
 * The decision path: approval mode × credential
 * availability. This is the gate the whole app exists to be, and until the
 * branching moved out of `main.ts` none of it was reachable by a test.
 *
 * What must hold, whatever the settings say:
 *   - a review that cannot run never becomes an approval — in adversarial mode
 *     it denies, in Ask mode the dialog was always the decider;
 *   - the audit log names the model that actually ran;
 *   - the relay credential reaches the reviewer and nothing else.
 *
 * Nothing here touches a network or a display: the reviewer and the approval
 * dialog are both injected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Intent, JSONValue, makeIntent } from "@domo/protocol";
import { adversarialReview } from "../src/adversarialAgent.js";
import type { ReviewArgs, ReviewFailureCause, Verdict } from "../src/adversarialAgent.js";
import { APPROVAL_SOURCE_EXPIRED, ApprovalStore, DENIAL_SOURCE_NO_REVIEWER, PolicyEngine } from "@domo/device-core";
import type { PolicyDelegate } from "@domo/device-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Settings } from "../src/settings.js";
import { auditActivities, decidedByLabel } from "../src/viewModel.js";
import {
  ApprovalQueue,
  ReviewHint,
  decideIntent,
  inferenceStatus,
  reviewerAvailable,
  storedRuleMayGrant,
} from "../src/reviewPolicy.js";
import { REVIEWER_MODEL } from "../src/adversarialAgent.js";

const PLOW_CREDENTIAL = "plow_sk_do_not_leak_me";

// A real directory, because confinement canonicalizes (realpath) both sides.
const PLOW_ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "plow-root-"));

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    relayCredential: "",
    accountUid: "",
    mcpUrl: "",
    selectedTab: "audit",
    approvalMode: "ask",
    agentPurpose: "",
    ...overrides,
  };
}

function intent(): Intent {
  return makeIntent({
    agentId: "agent-1",
    agentDisplay: "Agent One",
    deviceId: "device-1",
    request: "run: ls",
    capabilities: [{ kind: "process.exec", argv: ["ls"] }],
    sessionId: "s1",
  });
}

/** A harness capturing what the policy asked of the world. */
function harness(
  s: Settings,
  opts: {
    verdict?: Verdict;
    reason?: string;
    cause?: ReviewFailureCause;
    decision?: "allow_once" | "always_allow" | "deny";
    intent?: Intent;
  } = {},
) {
  const records: { event: string; fields: Record<string, JSONValue> }[] = [];
  const reviewCalls: ReviewArgs[] = [];
  const dialogs: (Promise<ReviewHint> | null)[] = [];
  const review = vi.fn(async (args: ReviewArgs) => {
    reviewCalls.push(args);
    return {
      verdict: opts.verdict ?? "ask",
      reason: opts.reason ?? "because",
      ...(opts.cause ? { cause: opts.cause } : {}),
    };
  });
  const openApproval = vi.fn(async (hint: Promise<ReviewHint> | null) => {
    dialogs.push(hint);
    return opts.decision ?? ("deny" as const);
  });
  const run = () =>
    decideIntent(opts.intent ?? intent(), {
      settings: s,
      apiBaseUrl: "https://api.plow.co",
      plowRoot: PLOW_ROOT,
      auditEntries: () => [],
      queue: new ApprovalQueue(),
      ruleAnswers: async () => false,
      storeRule: () => {},
      record: (event, fields) => records.push({ event, fields }),
      review,
      openApproval,
    });
  return { run, records, reviewCalls, dialogs, review, openApproval };
}

/**
 * What is actually PASSED, not what the prompt says.
 *
 * The ratchet was never a wording problem, so this asserts on the argument
 * `decideIntent` builds: a denial-soaked audit log and an empty one produce the
 * identical review call, because the history handed over is empty either way.
 */
describe("nothing about the past reaches the reviewer", () => {
  it("passes an empty history however full the audit log is", async () => {
    const reviewCalls: ReviewArgs[] = [];
    const review = vi.fn(async (args: ReviewArgs) => {
      reviewCalls.push(args);
      return { verdict: "allow" as const, reason: "fine" };
    });
    const soaked: JSONValue[] = [
      { event: "intent_received", intentId: "old", agent: "agent-1", request: "browse: doordash.com" },
      { event: "intent_decision", intentId: "old", decision: "deny", source: "adversarial" },
      {
        event: "adversarial_review_result",
        intentId: "old",
        verdict: "deny",
        reason: "compromised or misaligned agent",
      },
      { event: "file_read", intentId: "old", path: "/tmp/earlier.txt" },
    ];
    await decideIntent(intent(), {
      settings: settings({ approvalMode: "adversarial", relayCredential: PLOW_CREDENTIAL }),
      apiBaseUrl: "https://api.plow.co",
      plowRoot: PLOW_ROOT,
      auditEntries: () => soaked,
      record: () => {},
      review,
      openApproval: async () => "deny" as const,
    });

    expect(reviewCalls).toHaveLength(1);
    expect(reviewCalls[0].history).toEqual([]);
    const serialized = JSON.stringify(reviewCalls[0]);
    expect(serialized).not.toContain("compromised");
    expect(serialized).not.toContain("earlier.txt");
  });
});

describe("availability is credential presence", () => {
  it("signed in, or not", () => {
    expect(reviewerAvailable(settings())).toBe(false);
    expect(reviewerAvailable(settings({ relayCredential: PLOW_CREDENTIAL }))).toBe(true);
  });

  it("whitespace is not a credential", () => {
    expect(reviewerAvailable(settings({ relayCredential: "   " }))).toBe(false);
  });
});

describe("the model reported is the model that runs", () => {
  it("the wire id, provider prefix and all", () => {
    // A bare id is rejected by Plow's allowlist, and this is the value the
    // audit log records.
    expect(REVIEWER_MODEL).toBe("anthropic/claude-sonnet-4-6");
  });

  it("the audit record names the model that ran", async () => {
    // The audit log is the test oracle (CLAUDE.md). A review recorded under a
    // model that never saw the intent makes it lie.
    const h = harness(
      settings({ approvalMode: "adversarial", relayCredential: PLOW_CREDENTIAL }),
      { verdict: "allow" },
    );
    await h.run();
    const started = h.records.find((r) => r.event === "adversarial_review_started");
    expect(started?.fields).toMatchObject({ model: "anthropic/claude-sonnet-4-6" });
    // The provider field went with the choice it recorded.
    expect(started?.fields).not.toHaveProperty("provider");
  });
});

/**
 * Which mode is running is something the app KNOWS, so the reviewer is told
 * rather than left to infer it from the owner's optional purpose text. It
 * decides whether `ask` is even in the schema the model answers into.
 */
describe("the reviewer is told whether anyone is behind it", () => {
  it("adversarial mode: nobody is", async () => {
    const h = harness(
      settings({ approvalMode: "adversarial", relayCredential: PLOW_CREDENTIAL }),
      { verdict: "allow" },
    );
    await h.run();
    expect(h.reviewCalls[0].humanAvailable).toBe(false);
  });

  it("ask mode's hint: somebody is — the dialog is coming either way", async () => {
    const h = harness(
      settings({
        approvalMode: "ask",
        relayCredential: PLOW_CREDENTIAL,
      }),
      { verdict: "ask" },
    );
    await h.run();
    await h.dialogs[0];
    expect(h.reviewCalls[0].humanAvailable).toBe(true);
  });
});

describe("decideIntent — modes that never reach the reviewer", () => {
  it.each([
    ["a plain command", [{ kind: "process.exec", argv: ["ls"] }]],
    [
      "a Messages send (process.exec + apple_events)",
      [
        { kind: "process.exec", argv: ["/usr/bin/osascript", "-e", "on run argv", "--", "hi", "+15555550100"] },
        { kind: "apple_events", allowed: true },
      ],
    ],
    // Approve means approve: a script runs outside the sandbox and is still allowed unread.
    [
      "an AppleScript (runs outside the sandbox)",
      [{ kind: "applescript", app: "Messages", bundleId: "com.apple.MobileSMS", script: 'on run argv\n  tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)\nend run' }],
    ],
  ] as const)("approve auto-allows %s without reviewing or prompting", async (_label, capabilities) => {
    const send = makeIntent({
      agentId: "agent-1",
      agentDisplay: "Agent One",
      deviceId: "device-1",
      request: "run",
      capabilities: [...capabilities],
      sessionId: "s1",
    });
    const h = harness(settings({ approvalMode: "approve", relayCredential: PLOW_CREDENTIAL }), { intent: send });
    expect(await h.run()).toEqual({ decision: "allow_once", source: "approve" });
    expect(h.review).not.toHaveBeenCalled();
    expect(h.openApproval).not.toHaveBeenCalled();
  });

  it("deny auto-denies without reviewing or prompting", async () => {
    const h = harness(settings({ approvalMode: "deny", relayCredential: PLOW_CREDENTIAL }));
    expect(await h.run()).toEqual({ decision: "deny", source: "policy" });
    expect(h.review).not.toHaveBeenCalled();
    expect(h.openApproval).not.toHaveBeenCalled();
  });
});

/**
 * The bypass: a stored always-allow rule is replayed by `PolicyEngine.decide`
 * BEFORE the delegate is consulted at all, so an agent with review switched on
 * auto-ran anything the human had ever pressed "always allow" on. Same class as
 * the bug the switch was written to fix — a control that reports success and
 * does nothing — and not visible from `decideIntent` alone, because the engine
 * never reaches it.
 *
 * Pinned against the REAL `PolicyEngine` with a real rule on disk. A fake
 * engine here would only assert that the test agrees with itself.
 */
describe("a stored rule cannot stand in for a required review", () => {
  let rulesDir: string;
  let engine: PolicyEngine;

  /** The delegate the app installs, minus Electron: it answers with the review
   * policy and vetoes rule replay exactly where `ElectronPolicy` does. */
  const delegate = (s: Settings, answer: () => Promise<Verdict>): PolicyDelegate & {
    calls: number;
  } => {
    const d = {
      calls: 0,
      mayGrantFromStoredRule: () => storedRuleMayGrant(s),
      async decideIntent(i: Intent) {
        d.calls += 1;
        return decideIntent(i, {
          settings: s,
          apiBaseUrl: "https://api.plow.co",
      plowRoot: PLOW_ROOT,
          auditEntries: () => [],
      queue: new ApprovalQueue(),
      ruleAnswers: async () => false,
      storeRule: () => {},
          record: () => {},
          review: async () => ({ verdict: await answer(), reason: "because" }),
          openApproval: async () => "deny" as const,
        });
      },
    };
    return d;
  };

  /** A Mac whose global mode hands the decision to the reviewer. */
  const reviewed = (over: Partial<Settings> = {}) =>
    settings({
      approvalMode: "adversarial",
      relayCredential: PLOW_CREDENTIAL,
      ...over,
    });

  /** Store an always-allow rule for the harness intent by making one. */
  const storeRule = async () => {
    const first: PolicyDelegate = { decideIntent: async () => "always_allow" as const };
    const grant = await engine.decide(intent(), first);
    expect(grant.decision).toBe("always_allow");
    expect(engine.allRules()).toHaveLength(1);
  };

  beforeEach(() => {
    rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-rules-"));
    engine = new PolicyEngine(path.join(rulesDir, "rules.json"));
  });

  afterEach(() => {
    fs.rmSync(rulesDir, { recursive: true, force: true });
  });

  it("replays the rule under a mode that lets a rule answer", async () => {
    // The behaviour that must survive the fix: rules still work.
    await storeRule();
    const d = delegate(settings({ approvalMode: "approve" }), async () => "allow");
    const grant = await engine.decide(intent(), d);

    expect(grant.decision).toBe("always_allow");
    expect(grant.source).toBe("rule");
    expect(d.calls).toBe(0);
  });

  it("THE BYPASS: does not replay it when the reviewer decides", async () => {
    await storeRule();
    const d = delegate(reviewed(), async () => "allow");
    const grant = await engine.decide(intent(), d);

    // The reviewer ran, and its verdict — not the cached click — is the answer.
    expect(d.calls).toBe(1);
    expect(grant.source).toBe("adversarial");
  });

  it("lets that review DENY what the stored rule would have allowed", async () => {
    await storeRule();
    const d = delegate(reviewed(), async () => "deny");
    const grant = await engine.decide(intent(), d);

    expect(grant.decision).toBe("deny");
    expect(grant.source).toBe("adversarial");
  });

  it("leaves the rule itself on disk — it is not a revocation", async () => {
    await storeRule();
    await engine.decide(intent(), delegate(reviewed(), async () => "allow"));

    // The switch changes who answers, not what the human once chose. Turn it
    // off and the rule applies again.
    expect(engine.allRules()).toHaveLength(1);
    const after = await engine.decide(intent(), delegate(settings(), async () => "allow"));
    expect(after.source).toBe("rule");
  });

  it("keeps global deny in front of the rule and the review alike", async () => {
    await storeRule();
    const d = delegate(reviewed({ approvalMode: "deny" }), async () => "allow");
    const grant = await engine.decide(intent(), d);

    expect(grant.decision).toBe("deny");
    expect(grant.source).toBe("policy");
  });

  it("fails closed when the veto itself throws", async () => {
    // A guard that errors must not read as permission, or the bypass returns
    // the moment the guard is the thing that broke.
    await storeRule();
    const d = delegate(reviewed(), async () => "deny");
    const grant = await engine.decide(intent(), {
      ...d,
      mayGrantFromStoredRule: () => {
        throw new Error("settings unreadable");
      },
    });

    expect(grant.source).not.toBe("rule");
    expect(grant.decision).toBe("deny");
  });

  it("keeps the plain behaviour for a delegate with no veto at all", async () => {
    await storeRule();
    const grant = await engine.decide(intent(), {
      decideIntent: async () => "deny" as const,
    });

    expect(grant.source).toBe("rule");
  });
});

describe("a queued dialog is answered by a rule stored ahead of it", () => {
  let rulesDir: string;
  let engine: PolicyEngine;

  beforeEach(() => {
    rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-rules-"));
    engine = new PolicyEngine(path.join(rulesDir, "rules.json"));
  });
  afterEach(() => {
    fs.rmSync(rulesDir, { recursive: true, force: true });
  });

  /** The first dialog is on screen. Its opening awaits the Plow-folder
   * confinement check, which is real file-system I/O, so wait rather than tick. */
  const firstShown = async (shown: string[]) => {
    for (let i = 0; i < 200 && shown.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
  };

  /** The intent a second agent call makes: same bound, so the same rule key. */
  const twin = () => intent();
  const other = () =>
    makeIntent({
      agentId: "agent-1",
      agentDisplay: "Agent One",
      deviceId: "device-1",
      request: "run: pwd",
      capabilities: [{ kind: "process.exec", argv: ["pwd"] }],
      sessionId: "s1",
    });

  /**
   * The app's delegate, minus Electron: ONE queue for every dialog, and the
   * engine re-asked for a rule when an intent's turn comes. `answers` is what
   * the human clicks, per request text, in the order that request's dialogs
   * open — per request, not per dialog, because each intent's confinement
   * check is file I/O and the order they reach the queue is not the order
   * they were made. A dialog with no answer left is a bug. Every dialog
   * stays open until `release()` lets the oldest open one go, so the rest
   * queue up behind it the way a burst of agent calls does.
   */
  type Answer = "allow_once" | "always_allow" | "deny";
  const delegate = (s: Settings, answers: Record<string, Answer[]>) => {
    const queue = new ApprovalQueue();
    const shown: string[] = [];
    const open: (() => void)[] = [];
    const d: PolicyDelegate = {
      mayGrantFromStoredRule: () => storedRuleMayGrant(s),
      decideIntent: (i: Intent) =>
        decideIntent(i, {
          settings: s,
          apiBaseUrl: "https://api.plow.co",
          plowRoot: PLOW_ROOT,
          auditEntries: () => [],
          record: () => {},
          review: async () => ({ verdict: "ask", reason: "" }),
          queue,
          ruleAnswers: () => engine.ruleAnswers(i, d),
          storeRule: () => engine.storeRule(i),
          openApproval: async () => {
            shown.push(i.request);
            await new Promise<void>((r) => open.push(r));
            const answer = answers[i.request]?.shift();
            if (!answer) throw new Error(`unexpected dialog for ${i.request}`);
            return answer;
          },
        }),
    };
    /** The human answers the dialog on screen — once there is one. */
    const release = async () => {
      for (let i = 0; i < 200 && open.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
      const answer = open.shift();
      if (!answer) throw new Error("no dialog to answer");
      answer();
    };
    return { d, shown, release };
  };

  /** Settled, or still waiting: what a grant promise has done so far. */
  const settled = async (p: Promise<unknown>) =>
    Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 20))]);

  it("grants the twins behind an 'always allow' as the rule, with no dialog", async () => {
    const { d, shown, release } = delegate(settings(), { "run: ls": ["always_allow"] });
    const first = engine.decide(intent(), d);
    const second = engine.decide(twin(), d);
    const third = engine.decide(twin(), d);
    // All three were checked against an empty rule set and are waiting on the
    // human; only the first has a window.
    await firstShown(shown);
    expect(shown).toEqual(["run: ls"]);

    await release();
    const grants = await Promise.all([first, second, third]);
    expect(grants.map((g) => g.decision)).toEqual(["always_allow", "always_allow", "always_allow"]);
    // The one the human answered, and the two the rule answered for them.
    expect(grants.map((g) => g.source).sort()).toEqual(["ask", "rule", "rule"]);
    expect(shown).toEqual(["run: ls"]);
    // One rule, stored once — the replayed grants did not rewrite it.
    expect(engine.allRules()).toHaveLength(1);
  });

  it("[A, B, A] answered 'always allow' on A leaves the human with [B]", async () => {
    const { d, shown, release } = delegate(settings(), {
      "run: ls": ["always_allow"],
      "run: pwd": ["deny"],
    });
    const a1 = engine.decide(intent(), d);
    const b = engine.decide(other(), d);
    const a2 = engine.decide(twin(), d);
    await firstShown(shown);
    // Whichever reached the queue first is on screen; answer until it is an A.
    while (shown[shown.length - 1] !== "run: ls") await release();
    expect(await settled(a2)).toBe(false);
    await release();

    // The trailing A is granted by the rule NOW, with B's dialog still open
    // — not once B is answered, and not by a dialog of its own.
    const [first, trailing] = await Promise.all([a1, a2]);
    expect(first.source).toBe("ask");
    expect(trailing).toMatchObject({ decision: "always_allow", source: "rule" });
    expect(await settled(b)).toBe(false);
    expect(shown.filter((r) => r === "run: ls")).toEqual(["run: ls"]);

    await release();
    expect(await b).toMatchObject({ decision: "deny", source: "ask" });
    expect(shown.sort()).toEqual(["run: ls", "run: pwd"]);
  });

  it("still asks about a queued request the new rule does not cover", async () => {
    const { d, shown, release } = delegate(settings(), {
      "run: ls": ["always_allow"],
      "run: pwd": ["deny"],
    });
    const first = engine.decide(intent(), d);
    const second = engine.decide(other(), d);
    await release();
    await release();
    const grants = await Promise.all([first, second]);
    expect(grants.map((g) => [g.decision, g.source])).toEqual([
      ["always_allow", "ask"],
      ["deny", "ask"],
    ]);
    expect(shown.sort()).toEqual(["run: ls", "run: pwd"]);
  });

  it("an 'allow once' ahead of a twin decides nothing for it", async () => {
    const { d, shown, release } = delegate(settings(), { "run: ls": ["allow_once", "deny"] });
    const first = engine.decide(intent(), d);
    const second = engine.decide(twin(), d);
    await release();
    await release();
    const grants = await Promise.all([first, second]);
    expect(grants.map((g) => g.decision).sort()).toEqual(["allow_once", "deny"]);
    expect(shown).toEqual(["run: ls", "run: ls"]);
    expect(engine.allRules()).toHaveLength(0);
  });

  it("opens the dialogs one at a time", async () => {
    const { d, shown, release } = delegate(settings(), {
      "run: ls": ["deny", "deny"],
      "run: pwd": ["deny"],
    });
    const all = Promise.all([engine.decide(intent(), d), engine.decide(other(), d), engine.decide(twin(), d)]);
    await firstShown(shown);
    // Two more are waiting on the queue, not on screen.
    await new Promise((r) => setTimeout(r, 5));
    expect(shown).toHaveLength(1);
    await release();
    await release();
    await release();
    await all;
    expect(shown.sort()).toEqual(["run: ls", "run: ls", "run: pwd"]);
  });

  it("an 'always allow' after the approval's deadline keeps its rule — only the request expires", async () => {
    // The app's real stack: the approval store's deadline wraps the dialog.
    // A clock the test controls, and a deadline the click will miss.
    let clock = 1_000;
    const ttl = 50;
    const openApproval = vi.fn(async () => {
      clock += ttl + 1; // the owner comes back to the window late
      return "always_allow" as const;
    });
    const dialog: PolicyDelegate = {
      mayGrantFromStoredRule: () => storedRuleMayGrant(settings()),
      decideIntent: (i: Intent) =>
        decideIntent(i, {
          settings: settings(),
          apiBaseUrl: "https://api.plow.co",
          plowRoot: PLOW_ROOT,
          auditEntries: () => [],
          record: () => {},
          review: async () => ({ verdict: "ask", reason: "" }),
          queue: new ApprovalQueue(),
          ruleAnswers: () => engine.ruleAnswers(i, dialog),
          storeRule: () => engine.storeRule(i),
          openApproval,
        }),
    };
    const store = new ApprovalStore(path.join(rulesDir, "approvals"), dialog, ttl, () => clock);
    const stored: string[] = [];
    engine.events.on("stored", ({ intentId }: { intentId: string }) => stored.push(intentId));

    const late = intent();
    const grant = await engine.decide(late, store);
    // The request: denied, as a timeout — the click came too late for it.
    expect(grant.decision).toBe("deny");
    expect(grant.source).toBe(APPROVAL_SOURCE_EXPIRED);
    // The choice: kept, and attributed to the request that made it.
    expect(engine.allRules()).toHaveLength(1);
    expect(stored).toEqual([late.intentId]);

    // So the next matching request is the rule's, with no dialog.
    const next = await engine.decide(twin(), store);
    expect(next).toMatchObject({ decision: "always_allow", source: "rule" });
    expect(openApproval).toHaveBeenCalledTimes(1);
  });

  it("an answer from a rule says the rule is in place, so completing it stores nothing", async () => {
    // What the engine sees when a queued request was answered by a rule: the
    // decision must carry `ruleStored`, or `decide` would store again on the
    // way out — and put back a rule revoked while the answer travelled.
    const decided = await decideIntent(intent(), {
      settings: settings(),
      apiBaseUrl: "https://api.plow.co",
      plowRoot: PLOW_ROOT,
      auditEntries: () => [],
      record: () => {},
      review: async () => ({ verdict: "ask", reason: "" }),
      queue: new ApprovalQueue(),
      ruleAnswers: async () => true,
      storeRule: () => { throw new Error("nothing to store"); },
      openApproval: async () => { throw new Error("no dialog"); },
    });
    expect(decided).toEqual({ decision: "always_allow", source: "rule", ruleStored: true });
  });

  it("a dialog that throws does not stall the ones behind it", async () => {
    const queue = new ApprovalQueue();
    const wait = { preempt: async () => null };
    await expect(
      queue.run({ ...wait, show: async () => { throw new Error("boom"); } }),
    ).rejects.toThrow("boom");
    await expect(
      queue.run({ ...wait, show: async () => ({ decision: "deny", source: "ask" }) }),
    ).resolves.toMatchObject({ decision: "deny" });
  });
});

describe("storedRuleMayGrant", () => {
  it.each([
    ["adversarial", false],
    ["approve", true],
    ["ask", true],
    ["deny", false],
  ])("under %s mode: %s", (mode, expected) => {
    // The two modes that take the decision away from the human refuse a
    // replay: adversarial gives it to the reviewer, deny refuses everything.
    // A rule is a cached human decision, and neither mode wants one.
    expect(storedRuleMayGrant(settings({ approvalMode: mode as Settings["approvalMode"] }))).toBe(
      expected,
    );
  });
});

describe("decideIntent — adversarial mode", () => {
  const adversarial = (over: Partial<Settings> = {}) =>
    settings({ approvalMode: "adversarial", relayCredential: PLOW_CREDENTIAL, ...over });

  // One review, two verdicts, two outcomes — and no dialog in either. The owner
  // chose "the reviewer decides", so a modal in this mode contradicts the
  // setting; there is no third verdict to hand over, because `ask` is not in
  // the schema the reviewer answers into when nobody is behind it.
  const decisionCases = [
    { verdict: "allow" as const, decision: "allow_once", source: "adversarial" },
    { verdict: "deny" as const, decision: "deny", source: "adversarial" },
  ];

  for (const c of decisionCases) {
    it(`a ${c.verdict} verdict is sourced to ${c.source}`, async () => {
      const h = harness(adversarial(), {
        verdict: c.verdict,
        reason: "genuinely ambiguous",
        decision: "allow_once",
      });
      expect(await h.run()).toEqual({ decision: c.decision, source: c.source });
      expect(h.openApproval).not.toHaveBeenCalled();
    });
  }

  /**
   * A review that reached no verdict — timed out, errored, rate-limited, refused,
   * answered unparseably — arrives here as one shape: `ask` with `cause: "unavailable"`
   * (adversarialAgent.test.ts pins each real failure onto that cause). It used
   * to open the dialog, so it needs its own proof that it no longer does; and
   * Ask mode's dialog has to still be there afterwards.
   */
  describe("no route reaches a modal", () => {
    it("a review with no usable verdict → deny, sourced reviewer_unavailable", async () => {
      // `decision` is what the dialog WOULD have answered. Nothing may turn
      // it into execution, because nothing may open it.
      const h = harness(adversarial(), {
        verdict: "ask",
        reason: "reviewer timed out",
        cause: "unavailable",
        decision: "allow_once",
      });
      expect(await h.run()).toEqual({ decision: "deny", source: "reviewer_unavailable" });
      expect(h.openApproval).not.toHaveBeenCalled();
      // The Activity pane shows this source, and it says only what is known.
      // "Could not run" would be a false account of a reviewer that ran and
      // refused, which lands on this same cause.
      expect(decidedByLabel("reviewer_unavailable")).toBe("AI Reviewer (no usable verdict)");
      // The reason the reviewer gave is still recorded, so the source is a
      // summary of the timeline rather than a replacement for it.
      // The cause rides the record too: the verdict alone says "ask", which
      // reads as a reviewer deferring rather than one that never answered.
      expect(h.records[1].fields).toMatchObject({
        verdict: "ask",
        reason: "reviewer timed out",
        cause: "unavailable",
      });
    });

    it("leaves Ask mode's dialog exactly where it was", async () => {
      const h = harness(settings({ relayCredential: PLOW_CREDENTIAL }), {
        verdict: "ask",
        reason: "genuinely ambiguous",
        decision: "allow_once",
      });
      expect(await h.run()).toEqual({ decision: "allow_once", source: "ask" });
      expect(h.openApproval).toHaveBeenCalledOnce();
    });
  });

  it("out of credits denies, and says so through the decision's source", async () => {
    // The reviewer the user configured can never run, so falling back to a
    // human would quietly change the mode they chose. Deny, and label it in a
    // way the device can turn into an answer the calling agent can read.
    //
    // Fails closed whatever the dialog would have said: there is no dialog, and
    // neither an allow_once nor an always_allow can turn this into execution.
    for (const decision of ["allow_once", "always_allow", "deny"] as const) {
      const h = harness(adversarial(), { verdict: "ask", cause: "no_credits", decision });
      expect(await h.run()).toEqual({ decision: "deny", source: "no_credits" });
      expect(h.openApproval).not.toHaveBeenCalled();
    }
  });

  it("records the review's start and its verdict, in that order", async () => {
    const h = harness(adversarial(), { verdict: "deny", reason: "reads credentials" });
    await h.run();
    expect(h.records.map((r) => r.event)).toEqual([
      "adversarial_review_started",
      "adversarial_review_result",
    ]);
    expect(h.records[1].fields).toMatchObject({ verdict: "deny", reason: "reads credentials" });
  });

  // The security property, per shape of "the reviewer cannot run": an
  // unusable reviewer DENIES, never approves — and a credential belonging to
  //
  // This used to fall to the dialog, because Adversarial without a credential
  // was refused and the mode was retired to Ask behind the user. The
  // gate is gone: the state is reachable, so it has to answer for itself. Deny
  // is the fail-closed answer, and `no_reviewer` is what makes it legible
  // instead of looking like a decision somebody made.
  //
  // Nothing is CALLED to find this out. The reviewer's absence is on disk, so
  // asking it would only buy an audit pair naming a model that never saw the
  // intent — which is why `reviewerAvailable` decides before `review()` runs.
  const unusableReviewers = [
    { name: "the reviewer has no credential at all", over: { relayCredential: "" } },
    { name: "the credential is whitespace", over: { relayCredential: "   " } },
  ];

  for (const c of unusableReviewers) {
    it(`denies, explaining itself, when ${c.name}`, async () => {
      const h = harness(
        settings({ approvalMode: "adversarial", ...c.over }),
        // What the dialog WOULD have said. It must not be reachable.
        { verdict: "ask", reason: "nobody to call", decision: "allow_once" },
      );
      const result = await h.run();
      expect(result.decision).toBe("deny");
      // The sentence itself lives in device-core (EXPLAINED_DENIALS) and is
      // pinned end to end by mcpServer.test.ts; here the contract is that this
      // path picks the explained source rather than a bare deny.
      expect(result.source).toBe(DENIAL_SOURCE_NO_REVIEWER);
      // No call, and therefore no timeline claiming a model started reviewing.
      expect(h.review).not.toHaveBeenCalled();
      expect(h.records).toEqual([]);
      // No dialog: the mode the user chose is honoured, not swapped for Ask.
      expect(h.openApproval).not.toHaveBeenCalled();
    });
  }

});

describe("decideIntent — ask mode and suggestions", () => {
  it("suggests when there is a credential", async () => {
    const h = harness(
      settings({ approvalMode: "ask", relayCredential: PLOW_CREDENTIAL }),
      { verdict: "allow", decision: "always_allow" },
    );
    // `ruleStored`: the dialog path stored the rule itself, and says so.
    expect(await h.run()).toEqual({ decision: "always_allow", source: "ask", ruleStored: true });
    expect(h.dialogs).toHaveLength(1);
    await expect(h.dialogs[0]).resolves.toEqual({
      decision: "allow_once",
      reason: "because",
    });
  });

  it("maps a deny verdict to the deny button, and ask to no hint", async () => {
    for (const [verdict, hint] of [
      ["deny", "deny"],
      ["ask", null],
    ] as const) {
      const h = harness(settings({ approvalMode: "ask", relayCredential: PLOW_CREDENTIAL }), { verdict });
      await h.run();
      await expect(h.dialogs[0]).resolves.toMatchObject({ decision: hint });
    }
  });

  it("skips the review when there is no credential", async () => {
    const h = harness(settings({ approvalMode: "ask" }));
    await h.run();
    expect(h.review).not.toHaveBeenCalled();
    expect(h.dialogs).toEqual([null]);
  });

  it("out of credits in ASK mode costs only the hint — the human still decides", async () => {
    // The user did not delegate the decision here, so a billing problem must
    // not turn into a denial. The dialog opens exactly as it always does.
    const h = harness(
      settings({ approvalMode: "ask", relayCredential: PLOW_CREDENTIAL }),
      { verdict: "ask", cause: "no_credits", reason: "insufficient Plow balance", decision: "allow_once" },
    );
    expect(await h.run()).toEqual({ decision: "allow_once", source: "ask" });
    expect(h.openApproval).toHaveBeenCalledOnce();
    await expect(h.dialogs[0]).resolves.toMatchObject({ decision: null });
  });

  it("a suggestion is only ever a hint — the human's click is the decision", async () => {
    const h = harness(settings({ approvalMode: "ask", relayCredential: PLOW_CREDENTIAL }), {
      verdict: "allow",
      decision: "deny",
    });
    expect(await h.run()).toEqual({ decision: "deny", source: "ask" });
  });
});

describe("decideIntent — what reaches the reviewer", () => {
  it("passes the Plow credential and base URL", async () => {
    const h = harness(
      settings({ approvalMode: "adversarial", relayCredential: PLOW_CREDENTIAL }),
      { verdict: "allow" },
    );
    await h.run();
    expect(h.reviewCalls[0]).toMatchObject({
      plowCredential: PLOW_CREDENTIAL,
      apiBaseUrl: "https://api.plow.co",
    });
  });

  it("puts the credential into the audit log nowhere", async () => {
    // CLAUDE.md's highest-severity rule for this change. The reviewer gets the
    // credential; the audit trail must not.
    const h = harness(
      settings({
        approvalMode: "adversarial",
        relayCredential: PLOW_CREDENTIAL,
      }),
      { verdict: "deny", reason: "nope" },
    );
    await h.run();
    const serialized = JSON.stringify(h.records);
    expect(serialized).not.toContain(PLOW_CREDENTIAL);
    expect(serialized).not.toContain(PLOW_CREDENTIAL.slice(0, 8));
  });
});

describe("the approval dialog's advice note carries no credential either", () => {
  // The FOURTH surface a credential-bearing `reason` reaches — after the
  // reviewer's return value, audit.ndjson, and the activity view. Every other
  // test in this file injects a fake reviewer, so none of them exercise the
  // provider's guard; this one runs the REAL reviewer against a hostile body.
  const hostileBody = (reason: string) => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ decision: "deny", reason }) } }],
    }),
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const hintFor = async (reason: string) => {
    vi.stubGlobal("fetch", async () => hostileBody(reason));
    const dialogs: (Promise<ReviewHint> | null)[] = [];
    await decideIntent(intent(), {
      settings: settings({
        approvalMode: "ask",
        relayCredential: PLOW_CREDENTIAL,
      }),
      apiBaseUrl: "https://api.plow.co",
      plowRoot: PLOW_ROOT,
      auditEntries: () => [],
      queue: new ApprovalQueue(),
      ruleAnswers: async () => false,
      storeRule: () => {},
      record: () => {},
      review: adversarialReview, // the REAL one, guard included
      openApproval: async (hint) => {
        dialogs.push(hint);
        return "deny";
      },
    });
    return dialogs[0] === null ? null : await dialogs[0];
  };

  it("a verdict repeating the credential never reaches the note", async () => {
    const said = await hintFor(PLOW_CREDENTIAL);
    expect(JSON.stringify(said)).not.toContain(PLOW_CREDENTIAL);
    expect(JSON.stringify(said)).not.toContain(PLOW_CREDENTIAL.slice(0, 10));
    // Discarded, so there is no button to highlight either.
    expect(said?.decision).toBeNull();
  });

  it("an ordinary verdict still reaches the note, in the reviewer's words", async () => {
    const said = await hintFor("reads credentials from ~/.ssh");
    expect(said).toEqual({ decision: "deny", reason: "reads credentials from ~/.ssh" });
  });
});

describe("the renderer's view of inference carries no credentials", () => {
  const full = settings({ relayCredential: PLOW_CREDENTIAL });

  it("is a boolean and the stored mode, and nothing else", () => {
    expect(inferenceStatus(full)).toEqual({
      available: true,
      approvalMode: full.approvalMode,
    });
  });

  it("contains no credential, nor any prefix of one", () => {
    const serialized = JSON.stringify(inferenceStatus(full));
    expect(serialized).not.toContain(PLOW_CREDENTIAL);
    expect(serialized).not.toContain(PLOW_CREDENTIAL.slice(0, 8));
  });

});

// What used to sit here: `modeAfterAvailabilityChange`, which retired
// Adversarial to Ask whenever the active provider lost its credential. The
// function is gone with the gate. Losing a credential no longer rewrites the
// user's mode behind them — the mode stays, and every operation it decides is
// denied with `no_reviewer` until the credential comes back. That contract is
// pinned by the adversarial-mode describe above and by settingsActions.test.

describe("settings defaults", () => {
  let loadSettings: typeof import("../src/settings.js").loadSettings;
  beforeEach(async () => {
    ({ loadSettings } = await import("../src/settings.js"));
  });

  it("a settings.json that was never written reads as an unusable reviewer", () => {
    const s = loadSettings("/nonexistent-domo-home");
    expect(reviewerAvailable(s)).toBe(false);
    // Adversarial by default — with no credential it fails closed (deny),
    // never a silent grant.
    expect(s.approvalMode).toBe("adversarial");
  });
});

describe("the audit tells one coherent story about who decided", () => {
  /**
   * The timeline a human actually reads: the recorded events run through the
   * same view model the activity pane renders from.
   */
  const narrative = (
    records: { event: string; fields: Record<string, JSONValue> }[],
    decision: { decision: string; source: string },
    intentId: string,
  ) => {
    const ts = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    const events: JSONValue[] = [
      { ts: ts(0), event: "intent_received", intentId, agent: "agent-1", agent_name: "Agent One",
        request: "run: ls", goal: "", capabilities: ["Run: ls"] },
      ...records.map((r, i) => ({ ts: ts(i + 1), event: r.event, ...r.fields })),
      { ts: ts(records.length + 1), event: "intent_decision", intentId,
        decision: decision.decision, source: decision.source },
    ];
    return auditActivities(events).flatMap((a) => a.timeline.map((s) => s.text));
  };

  it("out of credits reads as 'could not run', never 'defer to you'", async () => {
    // The incoherence this pins: an `ask` verdict recorded, then an automatic
    // deny with no dialog in between. Read back, that said the agent handed the
    // decision to the owner and then something else silently denied it.
    const h = harness(
      settings({
        approvalMode: "adversarial",
        relayCredential: PLOW_CREDENTIAL,
      }),
      { verdict: "ask", cause: "no_credits", reason: "insufficient Plow balance" },
    );
    const decision = await h.run();
    const lines = narrative(h.records, decision, intent().intentId);

    expect(lines.some((l) => l.includes("could not run"))).toBe(true);
    expect(lines.some((l) => l.includes("defer to you"))).toBe(false);
    // …and the decision that follows names the same thing, in human words.
    expect(decidedByLabel(decision.source)).toBe("AI Reviewer (out of credits)");
    expect(decidedByLabel(decision.source)).not.toContain("no_credits");
  });

  it("a genuine abstention reads as 'would not decide'", async () => {
    // Ask mode, because that is where a genuine abstention still exists: the
    // hint may decline, and the human it defers to is actually there. In
    // adversarial mode `ask` is not in the schema at all, so there is nothing
    // left to render for it.
    const h = harness(
      settings({ relayCredential: PLOW_CREDENTIAL }),
      { verdict: "ask", reason: "genuinely ambiguous", decision: "allow_once" },
    );
    const decision = await h.run();
    await h.dialogs[0];
    const lines = narrative(h.records, decision, intent().intentId);
    const reviewLine = lines.find((l) => l.startsWith("AI Reviewer:")) ?? "";
    expect(reviewLine).toContain("would not decide");
    // Not "could not run" — that is the other failure, and this one ran.
    expect(reviewLine).not.toContain("could not run");
  });

  it("a review that reached no verdict does not claim the reviewer never ran", async () => {
    // `unavailable` is a bag: an outage, a rate limit, a refusal, an answer
    // that did not parse. Only the first two mean the reviewer never ran, and
    // nothing here knows which one happened — so the timeline says only that
    // no verdict came back. "Could not run" belongs to `no_credits`, which
    // does know.
    const h = harness(settings({ approvalMode: "adversarial", relayCredential: PLOW_CREDENTIAL }), {
      verdict: "ask",
      reason: "reviewer declined to assess",
      cause: "unavailable",
    });
    const decision = await h.run();
    const reviewLine =
      narrative(h.records, decision, intent().intentId).find((l) => l.startsWith("AI Reviewer:")) ?? "";
    expect(reviewLine).toContain("no usable verdict");
    expect(reviewLine).not.toContain("could not run");
    expect(decidedByLabel(decision.source)).toBe("AI Reviewer (no usable verdict)");
  });
});

/**
 * The purpose statement reaches the reviewer from SETTINGS, never from the
 * intent. That is the property the TRUSTED label in the prompt rests on, and it
 * lives here — this is the only place the two sources meet.
 */
describe("what the reviewer is told about the owner's purpose", () => {
  const PURPOSE = "Groceries and calendar only. Never touch ~/Developer.";

  it("hands the reviewer the stored purpose, alongside the intent it did not come from", async () => {
    const h = harness(
      settings({
        approvalMode: "adversarial",
        relayCredential: PLOW_CREDENTIAL,
        agentPurpose: PURPOSE,
      }),
      { verdict: "allow" },
    );

    await h.run();

    expect(h.reviewCalls).toHaveLength(1);
    expect(h.reviewCalls[0].agentPurpose).toBe(PURPOSE);
    // And it is not, and never was, on the intent.
    expect(JSON.stringify(h.reviewCalls[0].intent)).not.toContain("Groceries");
  });

  it("passes an empty string when the owner has said nothing", async () => {
    const h = harness(
      settings({ approvalMode: "adversarial", relayCredential: PLOW_CREDENTIAL }),
      { verdict: "allow" },
    );
    await h.run();
    expect(h.reviewCalls[0].agentPurpose).toBe("");
  });

  /**
   * The reviewer's own words are persisted to audit.ndjson and drawn in the
   * activity view. The purpose is not: the audit log records what was decided
   * and why the reviewer said so, not the standing instruction it was read
   * against.
   */
  it("keeps the purpose out of the audit record the review writes", async () => {
    const h = harness(
      settings({
        approvalMode: "adversarial",
        relayCredential: PLOW_CREDENTIAL,
        agentPurpose: PURPOSE,
      }),
      { verdict: "allow", reason: "fits routine shopping" },
    );

    await h.run();

    expect(JSON.stringify(h.records)).not.toContain("Groceries");
    expect(JSON.stringify(h.records)).not.toContain("~/Developer");
  });
});

/**
 * The ~/Plow playground: file operations confined to it are granted with no
 * reviewer and no dialog — in every mode except deny, which is the owner's
 * kill switch and must keep outranking the carve-out.
 */
describe("the ~/Plow playground carve-out", () => {
  function plowIntent(caps: Parameters<typeof makeIntent>[0]["capabilities"]): Intent {
    return makeIntent({
      agentId: "agent-1",
      agentDisplay: "Agent One",
      deviceId: "device-1",
      request: "write file",
      capabilities: caps,
      sessionId: "s1",
    });
  }

  function run(mode: Settings["approvalMode"], caps: Parameters<typeof makeIntent>[0]["capabilities"]) {
    const review = vi.fn(async () => ({ verdict: "deny" as const, reason: "no" }));
    const openApproval = vi.fn(async () => "deny" as const);
    const result = decideIntent(plowIntent(caps), {
      settings: settings({ approvalMode: mode, relayCredential: PLOW_CREDENTIAL }),
      apiBaseUrl: "https://api.plow.co",
      plowRoot: PLOW_ROOT,
      auditEntries: () => [],
      queue: new ApprovalQueue(),
      ruleAnswers: async () => false,
      storeRule: () => {},
      record: () => {},
      review,
      openApproval,
    });
    return { result, review, openApproval };
  }

  const confinedWrite = () => [{ kind: "fs.write" as const, paths: [path.join(PLOW_ROOT, "notes.md")] }];
  const confinedRead = () => [{ kind: "fs.read" as const, paths: [path.join(PLOW_ROOT, "a/b.txt")] }];
  const outsideWrite = () => [{ kind: "fs.write" as const, paths: [path.join(os.tmpdir(), "outside.txt")] }];
  const writeAndExec = () => [
    { kind: "fs.write" as const, paths: [path.join(PLOW_ROOT, "notes.md")] },
    { kind: "process.exec" as const, argv: ["ls"], cwd: PLOW_ROOT },
  ];

  it.each([
    ["a confined write in adversarial mode grants, no review spent", "adversarial", confinedWrite, "plow_folder", 0, 0],
    ["a confined read in ask mode grants, no dialog", "ask", confinedRead, "plow_folder", 0, 0],
    ["deny mode still refuses the playground", "deny", confinedWrite, "policy", 0, 0],
    // reviews=1 on the ask rows: suggestions are on, so the dialog gets a hint.
    ["a path outside the folder keeps the normal path", "ask", outsideWrite, "ask", 1, 1],
    ["exec disqualifies the whole set, even inside the folder", "ask", writeAndExec, "ask", 1, 1],
  ] as const)("%s", async (_name, mode, caps, source, reviews, dialogs) => {
    const { result, review, openApproval } = run(mode, caps());
    expect((await result).source).toBe(source);
    expect(review).toHaveBeenCalledTimes(reviews);
    expect(openApproval).toHaveBeenCalledTimes(dialogs);
  });
});
