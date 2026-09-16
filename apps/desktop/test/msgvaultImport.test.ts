/**
 * The owner-triggered import job: state transitions, single-flight, and the
 * audit trail it leaves. Pure — no Electron, no binary.
 */
import { describe, expect, it } from "vitest";
import { JSONValue } from "@domo/protocol";
import { IMESSAGE_IMPORT_LIMIT, MsgvaultImportJob } from "../src/msgvaultImport.js";

interface Recorded {
  event: string;
  fields: { [k: string]: JSONValue };
}

function harness(run: () => Promise<{ output: string }>) {
  const audits: Recorded[] = [];
  let changes = 0;
  const job = new MsgvaultImportJob({
    runImport: run,
    audit: (event, fields) => audits.push({ event, fields }),
    onChange: () => {
      changes += 1;
    },
  });
  return { job, audits, changes: () => changes };
}

/** A gate the test opens to let the fake import finish. */
function gated() {
  let open!: (r: { output: string }) => void;
  let fail!: (e: Error) => void;
  const promise = new Promise<{ output: string }>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("MsgvaultImportJob", () => {
  it("runs idle → running → idle-with-result and audits both ends", async () => {
    const gate = gated();
    const { job, audits } = harness(() => gate.promise);

    expect(job.state()).toEqual({ status: "idle", last: null });
    expect(job.start()).toBe(true);
    expect(job.state().status).toBe("running");
    expect(audits.map((a) => a.event)).toEqual(["msgvault_import_started"]);
    expect(audits[0].fields.limit).toBe(IMESSAGE_IMPORT_LIMIT);

    gate.open({ output: "Importing iMessages\nImported 100 messages\n" });
    await settle();

    const state = job.state();
    expect(state.status).toBe("idle");
    expect(state.last?.ok).toBe(true);
    expect(state.last?.summary).toBe("Imported 100 messages");
    expect(audits.map((a) => a.event)).toEqual([
      "msgvault_import_started",
      "msgvault_import_finished",
    ]);
    expect(audits[1].fields.ok).toBe(true);
  });

  it("summarizes the real CLI's block output by its imported-count line", async () => {
    const gate = gated();
    const { job } = harness(() => gate.promise);
    job.start();
    gate.open({
      output:
        "Importing iMessages from /Users/x/Library/Messages/chat.db\n" +
        "Limit: 100 messages\n\niMessage import complete!\n" +
        "  Messages:         100 imported\n  Rate:             223.4 messages/sec\n",
    });
    await settle();
    expect(job.state().last?.summary).toBe("Messages: 100 imported");
  });

  it("refuses to start while one is already running", async () => {
    const gate = gated();
    const { job } = harness(() => gate.promise);
    expect(job.start()).toBe(true);
    expect(job.start()).toBe(false);
    gate.open({ output: "done" });
    await settle();
    expect(job.start()).toBe(true);
  });

  it("a failed import lands as a not-ok result with the error as summary", async () => {
    const gate = gated();
    const { job, audits } = harness(() => gate.promise);
    job.start();
    gate.fail(new Error("iMessage database not found"));
    await settle();
    const state = job.state();
    expect(state.status).toBe("idle");
    expect(state.last?.ok).toBe(false);
    expect(state.last?.summary).toContain("not found");
    expect(audits[1].fields.ok).toBe(false);
  });

  it("notifies on every transition", async () => {
    const gate = gated();
    const { job, changes } = harness(() => gate.promise);
    job.start();
    expect(changes()).toBe(1);
    gate.open({ output: "done" });
    await settle();
    expect(changes()).toBe(2);
  });
});
