/**
 * What the approval window is allowed to say.
 *
 * The window's honesty is the product: it must never claim an agent stopped
 * waiting when nothing observed that, never promise a countdown it has already
 * spent, and never offer a "tell your agent to continue" phrase when there is
 * nothing left to continue. All three are checkable without a display, which is
 * why this logic is pure — and the window renders this very module rather than
 * a hand-copied twin of it.
 */
import { describe, expect, it } from "vitest";
import {
  CONFIRMATION_LINGER_MS,
  CONTINUE_PHRASE,
  continuationView,
  secondsLeft,
} from "../src/continuationView.js";

const NOW = 1_000_000;

describe("waiting inline", () => {
  it("counts down the measured remainder of the call, not a fresh budget", () => {
    // The window is handed the call's ABSOLUTE deadline. Validation, path
    // resolution and writing the approval down have already spent part of the
    // fifteen seconds by the time it opens, and a countdown that rounds in the
    // user's favour is worse than none.
    const view = continuationView({
      state: "waiting_inline",
      deadlineAt: NOW + 9_400,
      now: NOW,
      decided: false,
    });
    expect(view.remainingMs).toBe(9_400);
    // The clock is the countdown and nothing else: a second copy in the
    // headline ticked a beat apart from it.
    expect(view.headline).not.toMatch(/\d/);
    expect(secondsLeft(view.remainingMs!)).toBe(10);
    expect(view.confirmation).toBe(false);
    expect(view.showCopy).toBe(false);
    expect(view.closed).toBe(false);
  });

  it("never counts below zero", () => {
    const view = continuationView({
      state: "waiting_inline",
      deadlineAt: NOW + 1,
      now: NOW,
      decided: false,
    });
    expect(view.remainingMs).toBe(1);
  });

  it("stops claiming the agent is waiting once the deadline passes unconfirmed", () => {
    // The neutral state. The call's own deadline has gone by with no
    // acknowledgement, so "still waiting" would be a guess in one direction
    // and "handed off" a guess in the other — and the window may make neither.
    const view = continuationView({
      state: "waiting_inline",
      deadlineAt: NOW - 5_000,
      now: NOW,
      decided: false,
    });
    expect(view.headline).toContain("could not confirm");
    expect(view.headline).not.toContain("still waiting");
    expect(view.headline).not.toContain("stopped waiting");
    // No countdown to a deadline that has gone, and no copy action: there is
    // no result to come back for yet.
    expect(view.remainingMs).toBeNull();
    expect(view.showCopy).toBe(false);
    // The user's next move is the same either way, so it is offered — hedged.
    expect(view.detail).toContain("may need to");
    expect(view.detail).toContain(CONTINUE_PHRASE);
  });

  it("shows the neutral state the moment the relay says the exchange died", () => {
    // Before the deadline, too: a dropped socket is an observation, and it is
    // not the same observation as a successful handoff.
    const view = continuationView({
      state: "waiting_inline",
      deadlineAt: NOW + 9_000,
      now: NOW,
      decided: false,
      deliveryUnknown: true,
    });
    expect(view.headline).toContain("could not confirm");
    expect(view.remainingMs).toBeNull();
  });

  it("keeps the window open on a decision made after the deadline passed", () => {
    // The close-on-decision shortcut belongs to a call that was DEMONSTRABLY
    // still open. Past the deadline nobody knows, so the window stays and says
    // what to do about it.
    const view = continuationView({
      state: "waiting_inline",
      deadlineAt: NOW - 1,
      now: NOW,
      decided: true,
    });
    expect(view.closed).toBe(false);
    expect(view.confirmation).toBe(true);
    expect(view.headline).toContain("could not confirm");
  });

  it("says nothing about time when there is no deadline to measure", () => {
    const view = continuationView({
      state: "waiting_inline",
      deadlineAt: null,
      now: NOW,
      decided: false,
    });
    expect(view.remainingMs).toBeNull();
    expect(view.headline).toBe("The agent is still waiting on this call.");
  });

  it("closes on a decision made while the call is still open", () => {
    // The existing behaviour: an inline approval's window goes away when the
    // human answers, because the result rides the call they were holding.
    const view = continuationView({
      state: "waiting_inline",
      deadlineAt: NOW + 5_000,
      now: NOW,
      decided: true,
    });
    expect(view.closed).toBe(true);
    expect(view.headline).toBeNull();
  });

  it("rounds seconds up, so 1s never means already gone", () => {
    expect(secondsLeft(1)).toBe(1);
    expect(secondsLeft(999)).toBe(1);
    expect(secondsLeft(1_001)).toBe(2);
    expect(secondsLeft(0)).toBe(0);
  });
});

describe("backgrounded", () => {
  it("says the approval still counts, and what to tell the agent", () => {
    const view = continuationView({
      state: "backgrounded",
      deadlineAt: NOW - 1,
      now: NOW,
      decided: false,
    });
    expect(view.headline).toContain("stopped waiting");
    expect(view.detail).toContain("still counts");
    expect(view.detail).toContain(CONTINUE_PHRASE);
    // No countdown: there is no longer a call to count down to.
    expect(view.remainingMs).toBeNull();
    // And no copy action yet — there is no result to come back for.
    expect(view.showCopy).toBe(false);
  });

  it("becomes a confirmation once the decision is in, instead of closing", () => {
    const view = continuationView({
      state: "backgrounded",
      deadlineAt: NOW,
      now: NOW,
      decided: true,
    });
    expect(view.confirmation).toBe(true);
    expect(view.closed).toBe(false);
    expect(view.detail).toContain(CONTINUE_PHRASE);
  });
});

describe("the copy action exists only while it would help", () => {
  it("is offered while an approved result sits uncollected", () => {
    const view = continuationView({
      state: "approved_uncollected",
      deadlineAt: NOW,
      now: NOW,
      decided: true,
    });
    expect(view.showCopy).toBe(true);
    expect(view.confirmation).toBe(true);
    expect(view.headline).toContain("ready");
    expect(view.detail).toContain(CONTINUE_PHRASE);
  });

  it("is gone once the agent has collected, and the window closes", () => {
    const view = continuationView({
      state: "collected",
      deadlineAt: NOW,
      now: NOW,
      decided: true,
    });
    expect(view.showCopy).toBe(false);
    expect(view.closed).toBe(true);
  });

  it("is gone once retention has taken the result, and says so", () => {
    // Offering the phrase here would be an instruction to waste a turn: there
    // is nothing left for the agent to collect.
    const view = continuationView({
      state: "expired",
      deadlineAt: NOW,
      now: NOW,
      decided: true,
    });
    expect(view.showCopy).toBe(false);
    expect(view.closed).toBe(false);
    expect(view.headline).toContain("no longer available");
    expect(view.detail).not.toContain(CONTINUE_PHRASE);
  });

  it("is never offered before a decision, in any state", () => {
    for (const state of ["waiting_inline", "backgrounded", "approved_uncollected"] as const) {
      const view = continuationView({ state, deadlineAt: NOW + 1_000, now: NOW, decided: false });
      if (state === "approved_uncollected") continue;
      expect(view.showCopy).toBe(false);
    }
  });
});

describe("terminal outcomes", () => {
  it("closes the window on a denial or a failure", () => {
    for (const state of ["denied", "failed"] as const) {
      const view = continuationView({ state, deadlineAt: NOW, now: NOW, decided: true });
      expect(view.closed).toBe(true);
      expect(view.showCopy).toBe(false);
      expect(view.headline).toBeNull();
    }
  });

  it("shows nothing at all when no continuation is tracking the approval", () => {
    // A prompt with no deferred operation behind it — a direct policy ask, a
    // test harness. The window is exactly what it was before this existed.
    const view = continuationView({ state: null, deadlineAt: null, now: NOW, decided: false });
    expect(view).toEqual({
      headline: null,
      detail: null,
      remainingMs: null,
      confirmation: false,
      showCopy: false,
      closed: false,
    });
  });

  it("lingers a backgrounded confirmation for thirty seconds", () => {
    expect(CONFIRMATION_LINGER_MS).toBe(30_000);
  });
});
