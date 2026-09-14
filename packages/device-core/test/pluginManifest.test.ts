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

  it("accepts a full manifest: binaries, a source, exec in that source, a daemon and a hook", () => {
    const bin = { name: "bun", version: "1", url: { arm64: "https://x/bun", x64: "https://x/bun" }, sha256: { arm64: "a".repeat(64), x64: "b".repeat(64) }, executable: "bun-darwin/bun" };
    const m = parseManifest(withPatch({
      runtime: { binaries: [bin], sources: [{ name: "lib", git: "https://x/lib", commit: "c".repeat(40), install: ["bun", "install"] }] },
      exec: { cwd: "lib", argv: ["bun", "run", "cli.ts"] },
      daemon: { argv: ["serve"], health: "/health" },
      hooks: { postinstall: "hooks/post.sh" },
    }));
    expect(m.runtime.binaries).toEqual([bin]);
    expect(m.runtime.sources[0].install).toEqual(["bun", "install"]);
    expect(m.exec).toEqual({ cwd: "lib", argv: ["bun", "run", "cli.ts"] });
    expect(m.daemon).toEqual({ argv: ["serve"], health: "/health" });
    expect(m.hooks).toEqual({ postinstall: "hooks/post.sh" });
  });

  it.each([
    ["not JSON", "{", "manifest is not valid JSON"],
    ["a bad name", withPatch({ name: "Bad Name" }), "manifest name must be lowercase letters, digits and dashes"],
    ["a bad command", withPatch({ command: "a b" }), "manifest command must be lowercase letters, digits and dashes"],
    ["an unknown env source", withPatch({ env: { X: { argv: "no" } } }), "env value X must be one of fixed, secret or mint"],
    ["a binary without a sha for every arch", withPatch({ runtime: { binaries: [{ name: "b", version: "1", url: { arm64: "https://x/b", x64: "https://x/b" }, sha256: { arm64: "a".repeat(64) } }], sources: [] } }), "binary b needs a sha256 for arm64 and x64"],
    ["a binary with a non-https url", withPatch({ runtime: { binaries: [{ name: "b", version: "1", url: { arm64: "http://x/b", x64: "https://x/b" }, sha256: { arm64: "a".repeat(64), x64: "a".repeat(64) } }], sources: [] } }), "binary b needs an https url for arm64 and x64"],
    ["a binary whose executable escapes its archive", withPatch({ runtime: { binaries: [{ name: "b", version: "1", executable: "../b", url: { arm64: "https://x/b", x64: "https://x/b" }, sha256: { arm64: "a".repeat(64), x64: "a".repeat(64) } }], sources: [] } }), "binary b executable must be a path inside the plugin"],
    ["two binaries with one name", withPatch({ runtime: { binaries: [1, 2].map(() => ({ name: "b", version: "1", url: { arm64: "https://x/b", x64: "https://x/b" }, sha256: { arm64: "a".repeat(64), x64: "a".repeat(64) } })), sources: [] } }), "binary names must be unique"],
    ["a source git url that reads as a git option", withPatch({ runtime: { binaries: [], sources: [{ name: "s", git: "--upload-pack=x", commit: "a".repeat(40) }] } }), "source s needs a git url"],
    ["two sources with one name", withPatch({ runtime: { binaries: [], sources: [1, 2].map(() => ({ name: "s", git: "https://x/s", commit: "a".repeat(40) })) } }), "source names must be unique"],
    ["an exec.cwd that is not a runtime entry", withPatch({ exec: { cwd: "../..", argv: ["x"] } }), "exec.cwd must be plugin or a source name"],
    ["a skill path outside the repo", withPatch({ skill: "/etc/passwd" }), "skill must be a path inside the plugin"],
    ["a postinstall hook that climbs out", withPatch({ hooks: { postinstall: "hooks/../../x.sh" } }), "hooks.postinstall must be a path inside the plugin"],
    ["an empty postinstall hook", withPatch({ hooks: { postinstall: "" } }), "hooks.postinstall must be a path inside the plugin"],
    ["an env value with two sources", withPatch({ env: { X: { fixed: "a", secret: "b" } } }), "env value X must be one of fixed, secret or mint"],
    ["a source without a 40-char commit", withPatch({ runtime: { binaries: [], sources: [{ name: "s", git: "g", commit: "abc" }] } }), "source s needs a 40-character commit"],
    ["overlapping read and write prefixes", withPatch({ argv: { read: [["put"]], write: [["put", "x"]] } }), "argv prefixes must not overlap: put"],
    ["an empty prefix", withPatch({ argv: { read: [[]], write: [] } }), "argv prefixes must not be empty"],
    ["a missing exec", withPatch({ exec: undefined }), "manifest needs exec.cwd and exec.argv"],
    ["a daemon without health", withPatch({ daemon: { argv: ["serve"] } }), "daemon needs argv and health"],
    ["a non-string version", withPatch({ version: {} }), "manifest version must be a string"],
    ["a runtime that is not an object", withPatch({ runtime: "nope" }), "runtime must be an object"],
    ["an env that is not an object", withPatch({ env: [] }), "env must be an object"],
    ["an argv that is not an object", withPatch({ argv: "nope" }), "argv must be an object"],
    ["an empty daemon argv", withPatch({ daemon: { argv: [], health: "/health" } }), "daemon needs argv and health"],
  ])("refuses %s", (_name, raw, message) => {
    expect(() => parseManifest(raw)).toThrow(new PluginError(message));
  });
});
