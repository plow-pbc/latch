/**
 * The ported Session's fill branch, driven directly (no Python, no browser) —
 * the successor to the `describe.skipIf(!HAVE_PYTHON)` block that used to run
 * fillProbe.py. Every scenario the Python probe covered is here, ungated.
 */
import { describe, expect, it } from "vitest";
import { constants, ledger, ranked, run, twoFrames } from "./fillProbe.js";

const base = { action: "fill", selector: "#pass", value: "hunter2", frame: 0 };
const approved = { frame_token: "doc-1" };

describe("the server's fill branch, run directly", () => {
  it.each([
    { what: "an ordinary fill", value: "hunter2" },
    { what: "a concealed fill", value: "hunter2", mask: true },
  ])("refuses $what of a field that says it holds less", async ({ value, mask }) => {
    const r = await run({ ...base, value, ...(mask ? { mask } : {}) }, { maxLength: 4 });
    expect(r.result).toEqual({ ok: false, mask: "too_long", cap: 4, frame: 0 });
    expect(r.trace).toEqual(["frame.wait_for_selector"]);
    expect(r.marked).toBe(false);
    expect(r.ledgered).toBe(false);
  });

  it("counts maxlength in UTF-16 units, so four emoji are eight", async () => {
    const r = await run({ ...base, value: "\u{1F600}".repeat(4) }, { maxLength: 4 });
    expect(r.result).toEqual({ ok: false, mask: "too_long", cap: 4, frame: 0 });
  });

  it("does not refuse a value that only overflows before its break is dropped", async () => {
    const r = await run({ ...base, value: "one\ntwo" }, { maxLength: 6 });
    expect(r.result).toEqual({ ok: true, frame: 0, altered: true });
  });

  it("refuses the same value at a textarea, which keeps its breaks", async () => {
    const r = await run({ ...base, value: "one\ntwo" }, { maxLength: 6, typeable: "multiline" });
    expect(r.result).toEqual({ ok: false, mask: "too_long", cap: 6, frame: 0 });
    expect(r.trace).toEqual(["frame.wait_for_selector"]);
  });

  it("fills a value exactly as long as the field's cap", async () => {
    const r = await run({ ...base, value: "1234" }, { maxLength: 4 });
    expect(r.result).toEqual({ ok: true, frame: 0 });
  });

  it.each([
    { what: "groups the digits", value: "4111111111111111",
      rewrites: (t: string) => t.replace(/ /g, "").replace(/(.{4})/g, "$1 ").trim() },
    { what: "strips a space out of a name", value: "Jon Doe", rewrites: (t: string) => t.replace(/ /g, "") },
    { what: "truncates what it was given", value: "hunter2", rewrites: (t: string) => t.slice(0, 4) },
  ])("reports, without refusing, a field that $what", async ({ value, rewrites }) => {
    const r = await run({ ...base, value }, { rewrites });
    expect(r.result).toEqual({ ok: true, frame: 0, altered: true });
  });

  it("resolves the node once and marks it before the value goes in", async () => {
    const r = await run({ ...base, mask: true }, {});
    expect(r.trace).toEqual([
      "frame.wait_for_selector",
      "handle.evaluate:mark",
      "handle.assign",
      "handle.type",
    ]);
    expect(r.result).toEqual({ ok: true, mask: "stylesheet", frame: 0 });
  });

  it("types the value in rather than assigning it", async () => {
    const plain = await run(base, {});
    const masked = await run({ ...base, mask: true }, {});
    expect(plain.typed_delay).toBeGreaterThan(0);
    expect(masked.typed_delay).toBeGreaterThan(0);
  });

  it("assigns into a widget whose value is not the characters it is given", async () => {
    const r = await run({ ...base, value: "2026-08-19" }, { typeable: "" });
    expect(r.trace).not.toContain("handle.type");
    expect(r.typed_len).toBeNull();
    expect(r.node_len).toBe(r.asked_len);
    expect(r.result).toEqual({ ok: true, frame: 0 });
  });

  it("chooses an option in a select instead of typing", async () => {
    const r = await run({ ...base, value: "November" }, { typeable: "select", options: [["11", "November"]] });
    expect(r.trace).toEqual(["frame.wait_for_selector", "handle.select", "handle.evaluate:unmark"]);
    expect(r.typed_len).toBeNull();
    expect(r.result).toEqual({ ok: true, frame: 0 });
  });

  it("reports a select that has no such option as a failed fill", async () => {
    const r = await run({ ...base, value: "Smarch" }, { typeable: "select", options: [["11", "November"]] });
    expect(r.error).toBe("RuntimeError");
    expect(r.result).toBeNull();
  });

  it.each([
    { what: "an input drops a break it cannot hold", value: "one\ntwo", typedLen: 6, altered: true },
    { what: "the same break as CR, which must not reach the keys", value: "one\rtwo", typedLen: 6, altered: true },
    { what: "a textarea keeps its break", value: "one\ntwo", typeable: "multiline", typedLen: 7, altered: false },
    { what: "a CRLF becomes one break", value: "one\r\ntwo", typeable: "multiline", typedLen: 7, altered: true },
  ])("$what", async ({ value, typeable, typedLen, altered }) => {
    const r = await run({ ...base, value }, typeable ? { typeable } : {});
    expect(r.trace).toContain("handle.type");
    expect(r.typed_has_cr).toBe(false);
    expect(r.typed_len).toBe(typedLen);
    expect(r.result).toEqual({ ok: true, frame: 0, ...(altered ? { altered } : {}) });
  });

  it("assigns a value carrying a tab in the typed tail", async () => {
    const r = await run({ ...base, value: "one\ttwo" }, {});
    expect(r.trace).not.toContain("handle.type");
    expect(r.typed_len).toBeNull();
    expect(r.result).toEqual({ ok: true, frame: 0 });
  });

  it("types a 64-character credential whole", async () => {
    expect(constants.typed_chars).toBeGreaterThanOrEqual(64);
    const r = await run({ ...base, value: "k".repeat(64) }, {});
    expect(r.typed_len).toBe(r.asked_len);
  });

  it("types the tail of a value too long to type whole, and lands the rest", async () => {
    const long = await run({ ...base, value: "x".repeat(2000) }, {});
    expect(long.typed_len).toBe(constants.typed_chars);
    expect(long.node_len).toBe(long.asked_len);
    expect(long.result).toEqual({ ok: true, frame: 0 });
  });

  it("keeps the timed budgets under the shared deadline, per key", async () => {
    const long = await run({ ...base, value: "x".repeat(2000) }, {});
    expect(long.key_timeout_max).toBeLessThan(constants.typing_max_ms);
    expect(long.key_timeout_max! - long.key_timeout_min!).toBeGreaterThanOrEqual(long.type_calls - 1);
  });

  it("refuses when the frame behind the index is no longer the approved one", async () => {
    const moved = await run({ ...base, mask: true, ...approved }, { documentToken: "doc-2" });
    expect(moved.result).toEqual({ ok: false, mask: "moved", frame: 0 });
    expect(moved.trace).toEqual(["frame.wait_for_selector"]);
    expect(moved.marked).toBe(false);
    const same = await run({ ...base, mask: true, ...approved }, {});
    expect(same.result).toEqual({ ok: true, mask: "stylesheet", frame: 0 });
  });

  it("takes the mark back off when the fill it went with never landed", async () => {
    const orphan = await run({ ...base, mask: true }, { detachBeforeFill: true, value: "1 Elm St" });
    expect(orphan.trace).toEqual([
      "frame.wait_for_selector",
      "handle.evaluate:mark",
      "handle.assign-failed",
      "handle.evaluate:unmark",
    ]);
    expect(orphan.marked).toBe(false);
    expect(orphan.value_kept).toBe(true);
  });

  it("does not try the next frame once a node has been changed", async () => {
    const r = await twoFrames();
    expect(r.first_changed).toBe(true);
    expect(r.error).toBe("RuntimeError");
    expect(r.result).toBeNull();
    expect(r.second_len).toBe(0);
    expect(r.trace.filter((t) => t === "frame.wait_for_selector")).toHaveLength(1);
  });

  it("reports the frame that had the field, wherever the one that went away sits", async () => {
    expect(await ranked()).toEqual({ error: "Hidden", tried: 3 });
    expect(await ranked(true, false)).toEqual({ error: "Hidden", tried: 3 });
  });

  it("still hears the frame that went away when nothing else spoke", async () => {
    expect(await ranked(false)).toEqual({ error: "Detached", tried: 2 });
  });

  it("keeps a concealed field tracked, and lets the observation through", async () => {
    const kept = await ledger([
      { cmd: { action: "fill", selector: "#pass", value: "hunter2", frame: 1, mask: true } },
      { cmd: { action: "forms" } },
    ]);
    expect(kept.tracked).toEqual(["doc-1:#pass"]);
    expect(kept.marked["#pass"]).toBe(true);
    expect(kept.steps.at(-1)!.result).toEqual({});
  });

  it("forgets a field overwritten with something visible", async () => {
    const over = await ledger([
      { cmd: { action: "fill", selector: "#pass", value: "hunter2", frame: 1, mask: true } },
      { cmd: { action: "fill", selector: "#pass", value: "1 Elm St", frame: 1 } },
      { cmd: { action: "forms" } },
    ]);
    expect(over.tracked).toEqual([]);
    expect(over.marked["#pass"]).toBe(false);
  });

  it("forgets everything when the page navigates", async () => {
    const nav = await ledger([
      { cmd: { action: "fill", selector: "#pass", value: "hunter2", frame: 1, mask: true } },
      { navigate: "https://pizza.example/done" },
      { cmd: { action: "forms" } },
    ]);
    expect(nav.tracked).toEqual([]);
  });

  it("keeps the marks across a route change inside one document", async () => {
    const spa = await ledger([
      { cmd: { action: "fill", selector: "#pass", value: "hunter2", frame: 1, mask: true } },
      { route: "https://pizza.example/step2" },
      { rerender: "#pass" },
      { cmd: { action: "forms" } },
    ]);
    expect(spa.tracked).toEqual(["doc-1:#pass"]);
    expect(spa.marked["#pass"]).toBe(true);
  });

  it("forgets a field whose own frame navigated away", async () => {
    const gone = await ledger([
      { cmd: { action: "fill", selector: "#pass", value: "hunter2", frame: 1, mask: true } },
      { frame_navigated: "doc-elsewhere" },
      { cmd: { action: "forms" } },
    ]);
    expect(gone.tracked).toEqual([]);
    expect(gone.sibling_marked).toBe(false);
  });

  it("refuses the observation when a mark will not go back on", async () => {
    const wont = await ledger([
      { cmd: { action: "fill", selector: "#pass", value: "hunter2", frame: 1, mask: true } },
      { refuse: "#pass" },
      { cmd: { action: "forms" } },
    ]);
    expect(wont.steps.at(-1)!.result).toEqual({ ok: false, mask: "unmasked" });
  });
});
