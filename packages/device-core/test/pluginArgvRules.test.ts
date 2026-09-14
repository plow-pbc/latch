import { describe, expect, it } from "vitest";
import { classifyArgv, ruleArgv } from "../src/plugins/argvRules.js";
import { parseManifest } from "../src/plugins/manifest.js";
import { MINIMAL } from "./pluginManifest.test.js";

const m = parseManifest(JSON.stringify({ ...MINIMAL, argv: { read: [["query"], ["get", "page"]], write: [["put"]] } }));

describe("classifyArgv", () => {
  it.each([
    [["fix", "query", "anything at all", "--json"], { kind: "read", prefix: ["query"] }],
    [["fix", "get", "page", "p1"], { kind: "read", prefix: ["get", "page"] }],
    [["fix", "put", "p1", "--body", "x"], { kind: "write" }],
    [["fix", "get"], { kind: "refused", reason: "fix allows: query, get page, put" }],
    [["fix", "serve"], { kind: "refused", reason: "fix allows: query, get page, put" }],
    [["fix"], { kind: "refused", reason: "fix allows: query, get page, put" }],
    [["fix", "--json", "query"], { kind: "refused", reason: "fix allows: query, get page, put" }],
  ])("%j", (argv, verdict) => {
    expect(classifyArgv(m, argv)).toEqual(verdict);
  });
});

describe("ruleArgv", () => {
  it("keys a read on the prefix, so one rule covers every future query", () => {
    expect(ruleArgv(m, ["fix", "query", "a"])).toEqual(["fix", "query"]);
    expect(ruleArgv(m, ["fix", "query", "b", "--json"])).toEqual(["fix", "query"]);
  });
  it("keys a write on the whole argv", () => {
    expect(ruleArgv(m, ["fix", "put", "p1"])).toEqual(["fix", "put", "p1"]);
  });
});
