import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attentionMatches,
  createSerialAutosave,
  modeView,
} from "../src/renderer/gatekeeperState.js";

afterEach(() => vi.useRealTimers());

describe("Gatekeeper mode presentation", () => {
  it.each([
    ["adversarial", "Enabled", "AI Reviewer decides each request using your instructions."],
    ["ask", "Ask every time", "You decide every request in an approval window."],
    ["approve", "Approve everything", "Every request runs without review."],
    ["deny", "Deny everything", "Every request is refused."],
  ])("explains %s mode", (mode, label, description) => {
    expect(modeView(mode)).toEqual({ mode, label, description });
  });

  it("falls back to Ask every time for an unknown stored mode", () => {
    expect(modeView("future-mode")).toEqual({
      mode: "ask",
      label: "Ask every time",
      description: "You decide every request in an approval window.",
    });
  });
});

describe("Gatekeeper attention", () => {
  it("matches only the denied audit activity with the same intent", () => {
    expect(attentionMatches({ intentId: "i1" }, { intentId: "i1", decisionKind: "denied" })).toBe(true);
    expect(attentionMatches({ intentId: "i1" }, { intentId: "i2", decisionKind: "denied" })).toBe(false);
    expect(attentionMatches({ intentId: "i1" }, { intentId: "i1", decisionKind: "allowed" })).toBe(false);
    expect(attentionMatches(null, { intentId: "i1", decisionKind: "denied" })).toBe(false);
  });
});

describe("serial Gatekeeper autosave", () => {
  it("saves a newer draft after the in-flight write without claiming the old draft is saved", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const phases: string[] = [];
    const autosave = createSerialAutosave(async (value: string) => {
      writes.push(value);
      if (writes.length === 1) await first;
      return value;
    }, 50);
    autosave.subscribe((state: { phase: string }) => phases.push(state.phase));

    autosave.edit("first");
    await vi.advanceTimersByTimeAsync(50);
    expect(autosave.state()).toMatchObject({ phase: "saving", draft: "first" });

    autosave.edit("second");
    releaseFirst();
    await autosave.flush();

    expect(writes).toEqual(["first", "second"]);
    expect(autosave.state()).toEqual({ phase: "saved", draft: "second", stored: "second", error: null });
    expect(phases.filter((phase) => phase === "saved")).toHaveLength(1);
  });

  it("keeps a rejected draft visible and retries it", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const autosave = createSerialAutosave(async (value: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error("disk full");
      return value.trim();
    }, 50);

    autosave.edit(" keep me ");
    await vi.advanceTimersByTimeAsync(50);
    await autosave.flush();
    expect(autosave.state()).toMatchObject({ phase: "error", draft: " keep me ", stored: "" });

    autosave.retry();
    await autosave.flush();
    expect(autosave.state()).toEqual({ phase: "saved", draft: "keep me", stored: "keep me", error: null });
  });
});
