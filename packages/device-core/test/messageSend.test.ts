/**
 * A message send is one script and one store check.
 *
 * The body rides in argv. A display name never becomes a recipient. WhatsApp
 * is refused before any keystroke when Accessibility is not granted. Zero
 * new rows, or more than one, is unverified, and the script is not run again.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalRecipient,
  imessageScript,
  IMESSAGE_PARTICIPANT_SCRIPT,
  parseOutbound,
  performMessageSend,
  RECIPIENT_NOT_A_HANDLE,
  verifyOutcome,
  whatsappOpenUrl,
  WHATSAPP_SCRIPT,
  type MessageSendDeps,
  type MessageSendRequest,
} from "@domo/device-core";

function harness(opts: {
  snapshot?: string;
  listed?: string;
  snapshotThrows?: boolean;
  verifyThrows?: boolean;
  exitCode?: number | null;
  stderr?: string;
}): { deps: MessageSendDeps; scripts: number } {
  let scripts = 0;
  const deps: MessageSendDeps = {
    query: async (sql) => {
      if (sql.includes("coalesce(max")) {
        if (opts.snapshotThrows) throw new Error("sqlite down");
        return opts.snapshot ?? "4";
      }
      if (opts.verifyThrows) throw new Error("sqlite down");
      return opts.listed ?? "";
    },
    runScript: async () => {
      scripts += 1;
      return { exitCode: opts.exitCode ?? 0, stderr: opts.stderr ?? "" };
    },
    audit: () => {},
  };
  return {
    deps,
    get scripts() {
      return scripts;
    },
  };
}

const imessage = (over: Partial<MessageSendRequest> = {}): MessageSendRequest => ({
  intentId: "i1",
  app: "imessage",
  recipient: "ada@example.com",
  body: "hello",
  accessibility: "granted",
  ...over,
});

describe("canonicalRecipient", () => {
  it("keeps a phone, an email, a chat guid, and a jid, and drops a display name", () => {
    expect(canonicalRecipient("imessage", " +1 (415) 555-0100 ")).toBe("+14155550100");
    expect(canonicalRecipient("imessage", "Ada@Example.com")).toBe("ada@example.com");
    expect(canonicalRecipient("imessage", "any;-;+14155550100")).toBe("any;-;+14155550100");
    expect(canonicalRecipient("whatsapp", "14155550100@s.whatsapp.net")).toBe("14155550100@s.whatsapp.net");
    expect(canonicalRecipient("whatsapp", "+1 415 555 0100")).toBe("14155550100@s.whatsapp.net");
    expect(canonicalRecipient("whatsapp", "120363123@g.us")).toBe("120363123@g.us");
    expect(canonicalRecipient("imessage", "Ada Lovelace")).toBeNull();
    expect(canonicalRecipient("whatsapp", "Ada")).toBeNull();
    expect(RECIPIENT_NOT_A_HANDLE).not.toMatch(/Ada/);
  });
});

describe("verifyOutcome", () => {
  it("accepts exactly one successful row", () => {
    expect(verifyOutcome([{ rowid: 1, chat: "c", sent: false }, { rowid: 2, chat: "c", sent: true }])).toEqual({
      verified: true,
      row: { rowid: 2, chat: "c", sent: true },
    });
    expect(verifyOutcome([])).toEqual({ verified: false, reason: "none" });
    expect(
      verifyOutcome([
        { rowid: 1, chat: "c", sent: true },
        { rowid: 2, chat: "c", sent: true },
      ]),
    ).toEqual({ verified: false, reason: "many" });
  });
});

describe("performMessageSend", () => {
  it("reads is_sent, not the handle column, and puts the body in argv", async () => {
    const calls: { script: string; args: readonly string[] }[] = [];
    const deps: MessageSendDeps = {
      query: async (sql) => (sql.includes("coalesce(max") ? "4" : "9|iMessage;-;ada@example.com|ada@example.com|1|0|0|now"),
      runScript: async (script, args) => {
        calls.push({ script, args });
        return { exitCode: 0, stderr: "" };
      },
      audit: () => {},
    };
    const result = await performMessageSend(imessage({ body: 'say "hi"' }), deps);
    expect(result).toMatchObject({ status: "verified", row: { rowid: 9, chat: "iMessage;-;ada@example.com" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.script).toBe(IMESSAGE_PARTICIPANT_SCRIPT);
    expect(calls[0]?.args).toEqual(['say "hi"', "ada@example.com"]);
    expect(calls[0]?.script).not.toContain('say "hi"');
    expect(imessageScript("any;-;chat")).not.toBe(IMESSAGE_PARTICIPANT_SCRIPT);
  });

  it("a failed outbound row is unverified, and the script still ran once", async () => {
    const h = harness({ listed: "9|chat|ada@example.com|0|0|22|now" });
    const result = await performMessageSend(imessage(), h.deps);
    expect(result).toMatchObject({ status: "unverified", reason: "none" });
    expect(h.scripts).toBe(1);
    expect(parseOutbound("9|chat|ada@example.com|0|0|22|now", false)[0]?.sent).toBe(false);
  });

  it("does not send when the snapshot cannot be read", async () => {
    const h = harness({ snapshot: "nope" });
    const result = await performMessageSend(imessage(), h.deps);
    expect(result).toMatchObject({ status: "error" });
    expect(h.scripts).toBe(0);
  });

  it("stays unverified when the check itself fails, without a second script", async () => {
    const h = harness({ verifyThrows: true, exitCode: 0 });
    const result = await performMessageSend(imessage(), h.deps);
    expect(result).toMatchObject({ status: "unverified", reason: "none", script_exit: 0 });
    expect(h.scripts).toBe(1);
  });

  it("refuses WhatsApp before any keystroke when Accessibility is not granted", async () => {
    const h = harness({});
    const result = await performMessageSend(
      imessage({ app: "whatsapp", recipient: "14155550100@s.whatsapp.net", accessibility: "denied" }),
      h.deps,
    );
    expect(result).toMatchObject({ status: "blocked", host_gate: "accessibility" });
    expect(String(result.error)).not.toMatch(/Ada|1415/);
    expect(h.scripts).toBe(0);
  });

  it("opens the chat from the jid and treats one new from-me row as verified", async () => {
    const calls: { script: string; args: readonly string[] }[] = [];
    const deps: MessageSendDeps = {
      query: async (sql) => (sql.includes("coalesce(max") ? "3" : "8|14155550100@s.whatsapp.net|1"),
      runScript: async (script, args) => {
        calls.push({ script, args });
        return { exitCode: 0, stderr: "" };
      },
      audit: () => {},
    };
    const result = await performMessageSend(
      imessage({ app: "whatsapp", recipient: "14155550100@s.whatsapp.net", body: "on my way" }),
      deps,
    );
    expect(result).toMatchObject({ status: "verified", row: { rowid: 8 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.script).toBe(WHATSAPP_SCRIPT);
    expect(calls[0]?.args[1]).toBe(whatsappOpenUrl("14155550100@s.whatsapp.net"));
    expect(calls[0]?.args[1]).toBe("whatsapp://send?phone=14155550100");
    expect(whatsappOpenUrl("120363123@g.us")).toBe("whatsapp://send?jid=120363123@g.us");
    expect(calls[0]?.script).not.toContain("on my way");
  });

  it("a -1719 after the script is Accessibility, and it is not tried again", async () => {
    const h = harness({
      listed: "",
      exitCode: 1,
      stderr: "execution error: not allowed assistive access. (-1719)",
    });
    const result = await performMessageSend(
      imessage({ app: "whatsapp", recipient: "14155550100@s.whatsapp.net" }),
      h.deps,
    );
    expect(result).toMatchObject({ status: "blocked", host_gate: "accessibility" });
    expect(h.scripts).toBe(1);
  });
});
