import { describe, expect, it } from "vitest";
import type { AgentIndexEntry } from "../src/agentIndex.js";
import {
  cloudProviderPickerViewModel,
  DEPLOY_CARD_LIMIT,
  deployCards,
  plowOutageNotice,
} from "../src/cloudAgentViewModel.js";

describe("plowOutageNotice", () => {
  const unreachable = "Couldn't reach Plow at https://api.plow.co.";
  const allFailed = {
    rosterError: unreachable,
    cloudProvidersError: unreachable,
    cloudAgentsError: unreachable,
    cloudChatsError: unreachable,
  };
  const noneFailed = { rosterError: null, cloudProvidersError: null, cloudAgentsError: null, cloudChatsError: null };
  const offline = {
    title: "You're offline",
    body: "Check your Wi-Fi or network connection. Latch will reconnect on its own.",
  };
  const plowDown = {
    title: "Can't reach Plow right now",
    body: "Your Mac is online, but Plow isn't answering. Latch keeps trying and will reconnect on its own.",
  };

  it.each([
    ["the Mac is offline", allFailed, false, false, offline],
    ["the Mac is online but Plow is not reachable", allFailed, false, true, plowDown],
    ["any one read failed during the outage", { ...noneFailed, cloudChatsError: unreachable }, false, false, offline],
    ["the relay is down but every read landed", noneFailed, false, false, null],
    ["a read failed while the relay is up", allFailed, true, true, null],
  ] as const)("when %s", (_case, state, relayConnected, online, expected) => {
    expect(plowOutageNotice(state, relayConnected, online)).toEqual(expected);
  });
});

describe("cloudProviderPickerViewModel", () => {
  it.each([
    [
      "a list has not loaded",
      null,
      null,
      {
        mode: "blocked",
        heading: "Agent types could not be loaded",
        message: "Agent types couldn't be loaded yet. Try again.",
      },
    ],
    [
      "the live list is empty",
      [],
      null,
      {
        mode: "blocked",
        heading: "No agent types are available",
        message: "Plow has no cloud agent types available right now.",
      },
    ],
    [
      "the first list request failed",
      null,
      "Plow returned 503.",
      {
        mode: "blocked",
        heading: "Agent types could not be loaded",
        message: "Plow couldn't complete that request. Try again.",
      },
    ],
  ] as const)("renders %s", (_case, providers, error, expected) => {
    const providerList = providers === null
      ? null
      : providers.map((id) => ({ id, name: id, phrase: "Start" }));
    expect(cloudProviderPickerViewModel(providerList, error)).toEqual(expected);
  });

  it("renders a populated current list without failure copy", () => {
    expect(cloudProviderPickerViewModel([{ id: "provider/live", name: "Live", phrase: "Start Live" }], null)).toEqual({
      mode: "ready",
      heading: null,
      message: null,
    });
  });
});

describe("deployCards", () => {
  const provider = (id: string, name: string) => ({ id, name, phrase: `Start ${name}` });
  const entry = (users: number, extra: Partial<Omit<AgentIndexEntry, "users">> = {}) =>
    ({ blurb: "Does a thing.", builder: "Sam", successRate: 88, logo: null, verified: true, rank: 0, users, ...extra });

  it(`shows the Index's top ${DEPLOY_CARD_LIMIT} verified agents in its own rank, not by people`, () => {
    const ranked = ["G", "A", "F", "B", "E", "C", "D"]; // the Index's order
    const index = Object.fromEntries(ranked.map((name, rank) => [name, entry(rank, { rank })]));
    index.X = entry(99, { verified: false, rank: -1 });
    const cards = deployCards([..."ABCDEFGX", "hermes"].map((name) => provider(name, name)), index);
    expect(cards.map((card) => card.name)).toEqual(ranked.slice(0, DEPLOY_CARD_LIMIT));
  });

  // The Index is down or not read yet: a deploy never waits on it.
  it("lists every provider by name when none is verified in the Index", () => {
    const cards = deployCards([provider("b", "Bravo"), provider("a", "Alpha"), provider("x", "X")], { x: entry(9, { verified: false }) });
    expect(cards.map((card) => card.name)).toEqual(["Alpha", "Bravo", "X"]);
  });

  it.each([
    ["everything, at the rate floor", entry(5, { successRate: 80 }), "by Sam · 5 people · 80% set up"],
    ["no rate below 5 people", entry(4, { successRate: 100 }), "by Sam · 4 people"],
    ["one person", entry(1), "by Sam · 1 person"],
    ["no people part at zero", entry(0), "by Sam"],
    ["no builder", entry(16, { builder: null }), "16 people · 88% set up"],
    ["no rate known", entry(16, { successRate: null }), "by Sam · 16 people"],
  ] as const)("writes the byline with %s", (_case, described, byline) => {
    expect(deployCards([provider("x", "X")], { x: described })[0]?.byline).toBe(byline);
  });

  it("gives an undescribed agent its name only", () => {
    expect(deployCards([provider("hermes", " hermes")], {})).toEqual([
      { id: "hermes", name: " hermes", initial: "H", logo: null, blurb: null, byline: "No description yet" },
    ]);
  });

  it.each([["🦊 Fox", "🦊"], ["", "?"]])("takes %j's initial as one whole character", (name, initial) => {
    expect(deployCards([provider("x", name)], {})[0]?.initial).toBe(initial);
  });
});
