/**
 * The Import sheet's staging slot (importStaging.ts): the epoch that voids
 * in-flight inspects, and the tickets that let a sheet consume or drop only
 * its OWN staging. The scenario that forced the tickets into existence is
 * frozen here first: a credential exchange staged over an open sheet, whose
 * close used to cancel the exchange away before its preview was ever shown.
 */
import { describe, expect, it } from "vitest";
import type { ImportedLogin, ImportPreview } from "@domo/device-core";
import { ImportStaging, passwordsAppCanHandOff } from "../src/importStaging.js";

const login = (title: string): ImportedLogin => ({
  title,
  urls: [`https://${title}.example`],
  username: "u",
  password: "p",
  totp: "",
  notes: "",
  warnings: [],
});

const previewOf = (source: string): ImportPreview => ({ source, items: [], skipped: [] });

describe("passwordsAppCanHandOff", () => {
  it("knows which macOS grew the Export-to-App menu (26.4)", () => {
    expect(passwordsAppCanHandOff("26.4")).toBe(true);
    expect(passwordsAppCanHandOff("26.4.1")).toBe(true);
    expect(passwordsAppCanHandOff("27.0")).toBe(true);
    expect(passwordsAppCanHandOff("26.3.2")).toBe(false);
    expect(passwordsAppCanHandOff("26")).toBe(false);
    expect(passwordsAppCanHandOff("15.7")).toBe(false);
  });

  it("treats an unreadable version as too old, never as new enough", () => {
    expect(passwordsAppCanHandOff("")).toBe(false);
    expect(passwordsAppCanHandOff("beta")).toBe(false);
  });
});

describe("a sheet's own staging", () => {
  it("stages, hands back a ticket, and commit takes exactly what was staged — preview and all", () => {
    // The preview travels with the logins because the vault pick puts a
    // SUBSET of both straight back (vault:importPick): it needs the source
    // and the skipped rows the sheet was shown, not just the logins.
    const staging = new ImportStaging();
    const staged = staging.stageSheet(staging.epoch, [login("a")], previewOf("CSV"));
    expect(staged.ticket).toBeGreaterThan(0);
    const taken = staging.take(staged.ticket);
    expect(taken.logins.map((l) => l.title)).toEqual(["a"]);
    expect(taken.preview).toEqual(previewOf("CSV"));
  });

  it("cancel with the sheet's ticket drops it; a later commit finds nothing", () => {
    const staging = new ImportStaging();
    const staged = staging.stageSheet(staging.epoch, [login("a")], previewOf("CSV"));
    staging.cancel(staged.ticket);
    expect(() => staging.take(undefined)).toThrow(/nothing is staged/);
  });

  it("cancel with no ticket still drops an inspect that landed after the sheet stopped listening", () => {
    // The close raced the answer and lost: staging holds the plaintext, the
    // sheet never saw the ticket. Its null cancel is what mops that up.
    const staging = new ImportStaging();
    staging.stageSheet(staging.epoch, [login("a")], previewOf("CSV"));
    staging.cancel(null);
    expect(() => staging.take(undefined)).toThrow(/nothing is staged/);
  });

  it("an inspect that began before a cancel cannot stage its answer", () => {
    const staging = new ImportStaging();
    const epoch = staging.epoch; // captured at request start
    staging.cancel(null); // sheet closed while the parse was in flight
    const staged = staging.stageSheet(epoch, [login("a")], previewOf("CSV"));
    expect(staged.ticket).toBe(0);
    expect(() => staging.take(undefined)).toThrow(/nothing is staged/);
  });
});

describe("a credential exchange staged over an open sheet", () => {
  it("survives the stale sheet's ticketed close — the reported dismissal", () => {
    const staging = new ImportStaging();
    const sheet = staging.stageSheet(staging.epoch, [login("csv")], previewOf("CSV"));
    const exchange = staging.stageExchange([login("handoff")], previewOf("Passwords"));
    // The open sheet is closed to make way (renderer main.js) and quotes the
    // staging IT saw. That must not drop the exchange, whose preview the
    // vault pane is about to ask for.
    staging.cancel(sheet.ticket);
    expect(staging.pendingExchange()).toEqual(exchange);
    expect(staging.take(exchange.ticket).logins.map((l) => l.title)).toEqual(["handoff"]);
  });

  it("survives a sheet that closed before it ever saw a preview", () => {
    const staging = new ImportStaging();
    staging.stageExchange([login("handoff")], previewOf("Passwords"));
    staging.cancel(null); // the pick-step sheet had no ticket to quote
    expect(staging.pendingExchange()).not.toBeNull();
  });

  it("voids a sheet inspect still in flight when it stages", () => {
    const staging = new ImportStaging();
    const epoch = staging.epoch; // a paste is parsing…
    staging.stageExchange([login("handoff")], previewOf("Passwords"));
    const late = staging.stageSheet(epoch, [login("csv")], previewOf("CSV"));
    expect(late.ticket).toBe(0);
    expect(staging.pendingExchange()).not.toBeNull();
  });

  it("refuses the stale sheet's commit instead of importing the wrong rows", () => {
    const staging = new ImportStaging();
    const sheet = staging.stageSheet(staging.epoch, [login("csv")], previewOf("CSV"));
    staging.stageExchange([login("handoff")], previewOf("Passwords"));
    // The stale commit's row indices name rows of a preview that no longer
    // matches the slot. Refused before anything is cleared: the exchange is
    // still there for its own sheet.
    expect(() => staging.take(sheet.ticket)).toThrow(/newer import replaced/);
    expect(staging.pendingExchange()).not.toBeNull();
  });

  it("is answered for by its own sheet: commit takes it, and clears the pending preview", () => {
    const staging = new ImportStaging();
    const exchange = staging.stageExchange([login("handoff")], previewOf("Passwords"));
    expect(staging.take(exchange.ticket).logins.map((l) => l.title)).toEqual(["handoff"]);
    expect(staging.pendingExchange()).toBeNull();
  });

  it("its sheet's ticketed cancel drops it — Escape means no", () => {
    const staging = new ImportStaging();
    const exchange = staging.stageExchange([login("handoff")], previewOf("Passwords"));
    staging.cancel(exchange.ticket);
    expect(staging.pendingExchange()).toBeNull();
    expect(() => staging.take(undefined)).toThrow(/nothing is staged/);
  });

  it("a second exchange replaces the first, and the first sheet's close keeps the second", () => {
    const staging = new ImportStaging();
    const first = staging.stageExchange([login("one")], previewOf("Passwords"));
    const second = staging.stageExchange([login("two")], previewOf("Passwords"));
    staging.cancel(first.ticket);
    expect(staging.pendingExchange()).toEqual(second);
    expect(staging.take(second.ticket).logins.map((l) => l.title)).toEqual(["two"]);
  });

  it("a sheet's fresh staging replaces the exchange whole — preview included", () => {
    // The owner ignored the hand-off sheet, went back and pasted instead:
    // the exchange's staging is gone, so its pending preview must be too, or
    // the next vault render would reopen a sheet over rows that are not its.
    const staging = new ImportStaging();
    staging.stageExchange([login("handoff")], previewOf("Passwords"));
    const sheet = staging.stageSheet(staging.epoch, [login("csv")], previewOf("CSV"));
    expect(staging.pendingExchange()).toBeNull();
    expect(staging.take(sheet.ticket).logins.map((l) => l.title)).toEqual(["csv"]);
  });
});
