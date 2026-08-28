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
import {
  canEditChats,
  dropChat,
  editorChats,
  sortChatRows,
  makeHome,
  pickChat,
  sameChatSet,
} from "../src/renderer/chatSets.js";

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
    // a blank line; with no recipients, because we do not know them; and
    // carrying the same `title`/`subtitle` every other row has, so the row
    // renderer reads two fields for all of them rather than falling through to
    // `label` for some. The subtitle is empty: a chat the account list did not
    // return has no participants and no line to format.
    expect(shown[1]).toEqual({
      uid: "cht_gone",
      label: "+15559999 · Old thread",
      recipients: null,
      people: [],
      title: "+15559999 · Old thread",
      subtitle: "",
      lineName: null,
    });
  });

  it("falls back to the raw uid when the row has no label for it either", () => {
    const shown = editorChats(agent(["cht_bare"], [""]), []);

    expect(shown).toEqual([
      {
        uid: "cht_bare",
        label: "cht_bare",
        recipients: null,
        people: [],
        title: "cht_bare",
        subtitle: "",
        lineName: null,
      },
    ]);
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

describe("home-first chat selection", () => {
  const order = ["a", "b", "c"];

  it("makes the first pick home", () => {
    expect(pickChat([], "b")).toEqual(["b"]);
  });

  it("leaves home in place on the second pick", () => {
    expect(pickChat(["b"], "a")).toEqual(["b", "a"]);
  });

  it("promotes the earliest list entry when home is dropped", () => {
    expect(dropChat(["b", "c", "a"], "b", order)).toEqual(["a", "c"]);
  });

  it("keeps order when a non-home chat is dropped", () => {
    expect(dropChat(["b", "c", "a"], "c", order)).toEqual(["b", "a"]);
  });

  it("returns an empty selection when the last chat is dropped", () => {
    expect(dropChat(["b"], "b", order)).toEqual([]);
  });

  it("moves home to position zero without reordering the tail", () => {
    expect(makeHome(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });
});

describe("whether two chat sets say the same thing", () => {
  it("ignores the order of everything but home", () => {
    expect(sameChatSet(["a", "b", "c"], ["a", "c", "b"])).toBe(true);
  });

  it("counts a different home as a different set", () => {
    expect(sameChatSet(["b", "a", "c"], ["a", "b", "c"])).toBe(false);
  });

  it("counts changed membership or emptiness as a different set", () => {
    expect(sameChatSet(["a", "b"], ["a", "b", "c"])).toBe(false);
    expect(sameChatSet(["a", "b", "c"], ["a", "b"])).toBe(false);
    expect(sameChatSet(["a", "b"], ["a", "c"])).toBe(false);
    expect(sameChatSet([], [])).toBe(true);
    expect(sameChatSet([], ["a"])).toBe(false);
  });
});

describe("the order chat rows are shown in", () => {
  const row = (over: Record<string, unknown>) => ({
    uid: "u",
    label: "l",
    recipients: null,
    people: [],
    title: "t",
    subtitle: "",
    lineName: null,
    ...over,
  });

  it("groups by line without a header, then orders by title", () => {
    const shown = sortChatRows([
      row({ uid: "c1", lineName: "Willow", title: "Willow, Nina" }),
      row({ uid: "c2", lineName: "Ash", title: "Ash, You, Robin" }),
      row({ uid: "c3", lineName: "Willow", title: "Willow, Ada" }),
    ]);

    expect(shown.map((chat) => chat.uid)).toEqual(["c2", "c3", "c1"]);
  });

  it("compares the way a reader does, not by code unit", () => {
    // Locale-aware: an accented name sorts beside its plain form rather than
    // after every unaccented name on the account.
    const shown = sortChatRows([
      row({ uid: "c1", lineName: "Zoe" }),
      row({ uid: "c2", lineName: "Ámbar" }),
      row({ uid: "c3", lineName: "Ana" }),
    ]);

    expect(shown.map((chat) => chat.uid)).toEqual(["c2", "c3", "c1"]);
  });

  it("puts a chat whose line is unnamed last, not first", () => {
    // An empty string sorts before everything, which would put the least
    // identifiable rows at the top of the list.
    const shown = sortChatRows([
      row({ uid: "c1", lineName: null, title: "Aardvark" }),
      row({ uid: "c2", lineName: "Willow", title: "Zebra" }),
    ]);

    expect(shown.map((chat) => chat.uid)).toEqual(["c2", "c1"]);
  });

  it("is stable: equal rows keep the order the server sent", () => {
    const shown = sortChatRows([
      row({ uid: "c1", lineName: "Ash", title: "same" }),
      row({ uid: "c2", lineName: "Ash", title: "same" }),
      row({ uid: "c3", lineName: "Ash", title: "same" }),
    ]);

    expect(shown.map((chat) => chat.uid)).toEqual(["c1", "c2", "c3"]);
  });

  it("does not mutate what it was given", () => {
    const chats = [row({ uid: "c1", lineName: "Zoe" }), row({ uid: "c2", lineName: "Ash" })];
    sortChatRows(chats);
    expect(chats.map((chat) => chat.uid)).toEqual(["c1", "c2"]);
  });
});
