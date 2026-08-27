/* What the Edit-chats checklist is allowed to be built from.
 *
 * The property here is one-directional and is the whole reason the helper
 * exists: a chat the agent SERVES must never be missing from the list it is
 * edited in. A missing row is not a cosmetic gap — the checklist answers with
 * the boxes that are ticked, so a chat it never drew is a chat the next Save
 * detaches, silently, on behalf of someone who was never shown it.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS renderer module, shipped as-is (not compiled by tsc)
import { canEditChats, editorChats } from "../src/renderer/chatSets.js";

interface Chat {
  uid: string;
  label: string;
  recipients: { line: string | null; members: string[] } | null;
}

const chat = (uid: string, label: string): Chat => ({
  uid,
  label,
  recipients: { line: "+15550100", members: [] },
});

const agent = (chatUids: string[], chatLabels: string[] = []) => ({
  agentId: "cag_1",
  name: "Household helper",
  status: "running",
  chatUids,
  chatLabels: chatLabels.length ? chatLabels : chatUids,
});

describe("the chats an editor may show", () => {
  it("keeps the account's list and its order when it already covers the agent", () => {
    const chats = [chat("cht_1", "+15550100 · Ada"), chat("cht_2", "+15550200 · Bo")];

    const shown = editorChats(agent(["cht_2", "cht_1"]), chats);

    expect(shown).toEqual(chats);
  });

  it("adds a served chat the account's list does not mention", () => {
    // The chat list fell back to what activation left, or the owner has left a
    // chat the agent still serves. Either way the agent has it.
    const shown = editorChats(
      agent(["cht_gone", "cht_1"], ["+15559999 · Old thread", "+15550100 · Ada"]),
      [chat("cht_1", "+15550100 · Ada")],
    );

    expect(shown.map((option: Chat) => option.uid)).toEqual(["cht_1", "cht_gone"]);
    // Labelled from the row's own labels, so it reads as a chat rather than as
    // a blank line; and with no recipients, because we do not know them.
    expect(shown[1]).toEqual({
      uid: "cht_gone",
      label: "+15559999 · Old thread",
      recipients: null,
    });
  });

  it("falls back to the raw uid when the row has no label for it either", () => {
    const shown = editorChats(agent(["cht_bare"], [""]), []);

    expect(shown).toEqual([{ uid: "cht_bare", label: "cht_bare", recipients: null }]);
  });

  it("never shows a chat twice, whichever side it came from", () => {
    const shown = editorChats(agent(["cht_1", "cht_1", "cht_2"]), [chat("cht_1", "Ada")]);

    expect(shown.map((option: Chat) => option.uid)).toEqual(["cht_1", "cht_2"]);
  });

  it("shows every served chat even when the account's list is empty", () => {
    const served = ["cht_1", "cht_2", "cht_3"];

    const shown = editorChats(agent(served), []);

    expect(shown.map((option: Chat) => option.uid)).toEqual(served);
  });

  it("survives an agent or a list that is not there at all", () => {
    expect(editorChats(null, null)).toEqual([]);
    expect(editorChats(undefined, [chat("cht_1", "Ada")])).toEqual([chat("cht_1", "Ada")]);
  });
});

describe("whether the chat set may be edited at all", () => {
  it("waits for the account's chats before offering the editor", () => {
    // The fallback list is one chat or none. Opening on it would hide every
    // other chat on the account — `editorChats` keeps what is SERVED visible,
    // but nothing can put back what this Mac has not been told about.
    expect(canEditChats(agent(["cht_1"]), false)).toBe(false);
    expect(canEditChats(agent(["cht_1"]), true)).toBe(true);
  });

  it("refuses anything that is not a running, server-backed agent", () => {
    expect(canEditChats({ ...agent(["cht_1"]), status: "provisioning" }, true)).toBe(false);
    expect(canEditChats({ ...agent(["cht_1"]), status: "failed" }, true)).toBe(false);
    expect(canEditChats({ ...agent(["cht_1"]), localPending: true }, true)).toBe(false);
    expect(canEditChats(null, true)).toBe(false);
  });
});
