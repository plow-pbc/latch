import { describe, expect, it } from "vitest";
import { parseManifest, PluginError } from "../src/plugins/manifest.js";

export const MINIMAL = {
  name: "fix", version: "1", command: "fix",
  runtime: { binaries: [], sources: [] },
  exec: { cwd: "plugin", argv: ["/bin/sh", "cli.sh"] },
  env: { FIX_HOME: { fixed: "${plugin_home}" } },
  argv: { read: [["query"]], write: [["put"]] },
  skill: "skill.md",
};
const withPatch = (patch: object) => JSON.stringify({ ...MINIMAL, ...patch });

describe("parseManifest", () => {
  it("accepts the minimal manifest and fills defaults", () => {
    const m = parseManifest(JSON.stringify(MINIMAL));
    expect(m.daemon).toBeNull();
    expect(m.hooks).toEqual({});
    expect(m.runtime.binaries).toEqual([]);
  });

  it.each([
    ["not JSON", "{", "manifest is not valid JSON"],
    ["a bad name", withPatch({ name: "Bad Name" }), "manifest name must be lowercase letters, digits and dashes"],
    ["a bad command", withPatch({ command: "a b" }), "manifest command must be lowercase letters, digits and dashes"],
    ["an unknown env source", withPatch({ env: { X: { argv: "no" } } }), "env value X must be one of fixed, secret or mint"],
    ["a binary without a sha for every arch", withPatch({ runtime: { binaries: [{ name: "b", version: "1", url: { arm64: "u", x64: "u" }, sha256: { arm64: "a".repeat(64) } }], sources: [] } }), "binary b needs a sha256 for arm64 and x64"],
    ["a source without a 40-char commit", withPatch({ runtime: { binaries: [], sources: [{ name: "s", git: "g", commit: "abc" }] } }), "source s needs a 40-character commit"],
    ["overlapping read and write prefixes", withPatch({ argv: { read: [["put"]], write: [["put", "x"]] } }), "argv prefixes must not overlap: put"],
    ["an empty prefix", withPatch({ argv: { read: [[]], write: [] } }), "argv prefixes must not be empty"],
    ["a missing exec", withPatch({ exec: undefined }), "manifest needs exec.cwd and exec.argv"],
    ["a daemon without health", withPatch({ daemon: { argv: ["serve"] } }), "daemon needs argv and health"],
  ])("refuses %s", (_name, raw, message) => {
    expect(() => parseManifest(raw)).toThrow(new PluginError(message));
  });
});
