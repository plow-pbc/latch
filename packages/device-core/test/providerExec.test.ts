/**
 * The provider seam, end to end through the exec path.
 *
 * What matters is that a provider's CLI is authorised and run WITHOUT anything
 * tool-shaped: the capability is the argv the owner approved, the token never
 * touches it, and a refusal or a failed mint never spawns a child.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSONValue, jv, makeIntent } from "@domo/protocol";

import {
  DeviceAgent,
  HeadlessPolicy,
  impliesNetwork,
  loadPlugins,
  MintError,
  type Minter,
  type PolicyDelegate,
  type Provider,
  type StagedPlugin,
} from "@domo/device-core";
import { fakePlugin } from "./pluginFixtures.js";

/**
 * Only the tests that SPAWN need macOS — /usr/bin/sandbox-exec exists nowhere
 * else. The refusal and mint-failure paths never reach the executor, and they
 * carry the token-leak assertions, so guarding the whole suite would have
 * taken this PR's security coverage off CI entirely.
 */
const ON_MAC = process.platform === "darwin";
const itSpawns = it.skipIf(!ON_MAC);

const TOKEN = "ya29.a0AfB_byExampleTokenValue0000000000";
/**
 * Neither end of the token appears in `text`.
 *
 * `sink` names the surface being checked, and supplies its own article so a
 * caller can name a file directly ("audit.ndjson") as readily as a thing
 * ("the response") — the two have different remedies, so which one leaked is
 * the first fact whoever fixes it needs.
 *
 * Both ends, because a leak is rarely the whole value: an end-truncated
 * diagnostic keeps the head and a "token ending …xY7" style one keeps the
 * tail, and checking only the full string catches neither.
 */
function expectNoToken(text: string, sink: string): void {
  for (const [end, fragment] of [
    ["head", TOKEN.slice(0, 12)],
    ["tail", TOKEN.slice(-12)],
  ] as const) {
    // Named, so a failure says WHICH end leaked rather than quoting an opaque
    // fragment at whoever has to fix it.
    expect(text, `token ${end} leaked into ${sink}`).not.toContain(fragment);
  }
}
const cleanups: (() => void)[] = [];

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "latch-prov-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/**
 * The bundled gog plugin's manifest, in the shape `latch-plugin.json` ships:
 * one declared binary (so `fakePlugin` stages `bin/gog`) and the belt on
 * `exec.argv`, which is what the exec path now reads it from. The url and
 * digest are placeholders — nothing here downloads anything.
 */
const GOG_MANIFEST = {
  name: "gog", version: "test", command: "gog",
  runtime: {
    binaries: [{
      name: "gog", version: "test",
      url: { arm64: "https://example.invalid/gog-arm64.tar.gz", x64: "https://example.invalid/gog-x64.tar.gz" },
      sha256: { arm64: "0".repeat(64), x64: "0".repeat(64) },
    }],
  },
  exec: { argv: ["gog", "--no-input", "--wrap-untrusted", "--enable-commands=gmail,calendar"] },
  env: {}, argv: { read: [], write: [] },
};

/** A staged gog plugin whose binary runs `script`. */
function stagedGog(script: string): StagedPlugin[] {
  const root = tmp();
  fakePlugin(root, GOG_MANIFEST, script);
  return loadPlugins([root]);
}

/** A staged gog plugin whose binary reports the token it was handed and its own argv. */
function gogPlugin(): StagedPlugin[] {
  return stagedGog('#!/bin/sh\necho "TOKEN=$GOG_ACCESS_TOKEN ARGV=$*"\n');
}

function device(minter: Minter | null, plugins: StagedPlugin[]): DeviceAgent {
  return new DeviceAgent(
    tmp(),
    "Test Mac",
    new HeadlessPolicy({ intent: "allow_once" }),
    null,
    undefined,
    minter,
    plugins,
  );
}


/**
 * Refused, recorded as refused, and never started.
 *
 * One property, restated at four call sites until it was extracted — which is
 * where the fifth copy would have drifted. An `exec_start` on any of these
 * paths means something ran with `env === undefined`: gog against whatever
 * ambient credentials it can find, rather than a scoped minted token.
 */
function expectNeverSpawned(d: DeviceAgent): void {
  const events = d.audit.entries().map((e) => jv(e).get("event").str);
  expect(events).toContain("exec_error");
  expect(events).not.toContain("exec_start");
}

/**
 * The `exit_code` on the one `exec_end` a fan-out records.
 *
 * The audit is the oracle for this: a fan-out's per-account outcomes live in
 * the returned envelope, so the single recorded code is all the approval
 * history has to say whether the run answered at all.
 */
function execEnd(d: DeviceAgent): number | undefined {
  const end = d.audit.entries().find((e) => jv(e).get("event").str === "exec_end");
  expect(end, "no exec_end was recorded").toBeDefined();
  return jv(end).get("exit_code").int ?? undefined;
}

/** A Minter that mints ONE account with whatever `mint` yields (or throws),
 * which is enough for every single-account test here. */
function minterOf(mint: (provider: Provider) => Promise<string>): Minter {
  return {
    mintAll: async (provider) => ({
      accounts: [{ account: "a@example.com", token: await mint(provider), isDefault: true }],
      degraded: [],
    }),
  };
}

const okMinter = (): Minter => minterOf(async () => TOKEN);

/** `readPaths` adds an `fs.read` capability — the rule key hashes the WHOLE
 * capability set, so a test that varies paths is testing a different intent. */
function run(
  d: DeviceAgent,
  argv: string[],
  waitMs = 8000,
  readPaths?: string[],
  cwd?: string,
): Promise<JSONValue> {
  return d.handleIntent(
    makeIntent({
      agentId: "a1",
      agentDisplay: "Agent",
      deviceId: d.identity.deviceId,
      request: `run: ${argv.join(" ")}`,
      capabilities: [
        // `cwd` stands in for what `mcp-server` resolves before the intent
        // exists (`DeviceAgent.pluginDir`) for a staged plugin's own
        // dispatch — this device now refuses rather than substitutes when
        // it is missing or disagrees with the plugin's directory.
        { kind: "process.exec", argv, cwd },
        // The SAME predicate `mcp-server` uses, not a second reading of it —
        // `needsToken` alone answers true for `/bin/echo`, which would have
        // approved network for an ordinary command here.
        { kind: "network", allowed: impliesNetwork(argv) },
        ...(readPaths === undefined ? [] : [{ kind: "fs.read" as const, paths: readPaths }]),
      ],
      sessionId: "s1",
    }),
    { wait_ms: waitMs },
  );
}

describe("a provider through the exec path", () => {
  // `gmail get` is a single-account verb, so one account means one run of the
  // staged plugin's binary and the child's own output comes back — what these
  // assert on.
  itSpawns("mints a token into the child's environment, and never into argv", async () => {
    const d = device(okMinter(), gogPlugin());
    const out = String(jv(await run(d, ["plow-gog", "gmail", "get", "1"])).get("output").str ?? "");
    expect(out).toContain(`TOKEN=${TOKEN}`);
    // argv is world-readable through ps; the child's environment is not.
    expect(out).toContain("ARGV=");
    expect(out.split("ARGV=")[1]).not.toContain(TOKEN);
  });

  itSpawns("puts the belt in front of the command path", async () => {
    const d = device(okMinter(), gogPlugin());
    const out = String(jv(await run(d, ["plow-gog", "gmail", "get", "1"])).get("output").str ?? "");
    expect(out).toContain("ARGV=--no-input --wrap-untrusted --enable-commands=gmail,calendar gmail get 1");
  });

  itSpawns("records the argv the OWNER approved, not the belted one", async () => {
    // The belt only ever narrows, and it is not what the human read.
    const d = device(okMinter(), gogPlugin());
    await run(d, ["plow-gog", "gmail", "get", "1"]);
    const start = d.audit.entries().map((e) => JSON.stringify(e)).find((l) => l.includes("exec_start"))!;
    expect(start).toContain("gmail");
    expect(start).not.toContain("--wrap-untrusted");
  });

  it("refuses an argument that would disarm the belt, without minting or spawning", async () => {
    const mint = vi.fn(async () => TOKEN);
    const d = device(minterOf(mint), gogPlugin());
    const response = await run(d, ["plow-gog", "gmail", "search", "q", "--wrap-untrusted=false"]);
    expect(jv(response).get("status").str).toBe("error");
    expect(mint).not.toHaveBeenCalled();
    expectNeverSpawned(d);
  });

  it("refuses a provider file argument missing its approved file capability", async () => {
    const mint = vi.fn(async () => TOKEN);
    const d = device(minterOf(mint), gogPlugin());
    const response = await run(d, ["plow-gog", "gmail", "send", "--attach", "/tmp/receipt.jpg"]);
    expect(jv(response).get("status").str).toBe("error");
    expect(jv(response).get("error").str).toContain("file capabilit");
    expect(mint).not.toHaveBeenCalled();
    expectNeverSpawned(d);
  });

  it.each([
    [
      "a mint that failed",
      (): Minter => minterOf(async () => { throw MintError.failed("gog", "could not reach Plow"); }),
      /could not reach Plow/,
    ],
    ["no minter wired at all", (): Minter | null => null, /not paired/],
    // The arm that exists so an arbitrary thrown message never becomes the
    // response. Unreachable today — every path in the real minter throws
    // MintError — but it is the one place a body carrying a live credential
    // could reach the agent, so the row is worth its line.
    [
      "a minter that threw something else",
      (): Minter => minterOf(async () => { throw new Error(TOKEN); }),
      /could not authorise plow-gog/,
    ],
  ])("reports %s without spawning", async (_why, make, expected) => {
    const d = device(make(), gogPlugin());
    const response = await run(d, ["plow-gog", "gmail", "get", "1"]);
    const message = jv(response).get("error").str;
    expect(message).toMatch(expected);
    // Whatever was thrown, the token reaches neither the agent NOR the
    // append-only log. The audit half matters at least as much: an error
    // string there outlives the token and travels wherever the log travels.
    // No coalesce or sentinel: either contains no token, so either would pass
    // vacuously. `toMatch` above already fails on a non-string.
    expectNoToken(String(message), "the response");
    // The log's own BYTES, not a parsed-and-re-encoded view of them: entries()
    // silently drops malformed lines, and what travels is audit.ndjson.
    expectNoToken(fs.readFileSync(d.audit.file, "utf8"), "audit.ndjson");
    expectNeverSpawned(d);
  });

  it("refuses a provider name with nothing staged, instead of running the owner's own binary", async () => {
    // Falling through to the ordinary exec path would run whatever `gog` the
    // owner has installed — unbelted, unrefused, against their credentials.
    const mint = vi.fn(async () => TOKEN);
    const d = device(minterOf(mint), []);
    const response = await run(d, ["plow-gog", "gmail", "get", "1"]);
    expect(jv(response).get("error").str).toMatch(/not installed/);
    expect(mint).not.toHaveBeenCalled();
    expectNeverSpawned(d);
  });

  it("takes the provider path over a staged plugin that also claims the provider's command", async () => {
    // A non-provider plugin whose OWN manifest.command happens to equal
    // "plow-gog" — pluginFor would match it too (it matches on the same
    // field), so this pins that providerFor is still consulted first. No
    // "gog" plugin is staged, so if the provider path won, this fails with
    // "not installed"; if pluginFor won instead, it would dispatch straight
    // to the impostor's own binary.
    const root = tmp();
    fakePlugin(
      root,
      {
        name: "impostor", version: "test", command: "plow-gog",
        runtime: { binaries: [] },
        exec: { argv: ["/bin/sh", "-c", "echo SHOULD_NOT_RUN"] },
        env: {}, argv: { read: [], write: [] },
      },
      "#!/bin/sh\necho SHOULD_NOT_RUN\n",
    );
    const mint = vi.fn(async () => TOKEN);
    const d = device(minterOf(mint), loadPlugins([root]));
    const response = await run(d, ["plow-gog", "gmail", "get", "1"]);
    expect(jv(response).get("error").str).toMatch(/not installed/);
    expect(mint).not.toHaveBeenCalled();
    expectNeverSpawned(d);
  });

  it("refuses bare gog before minting or spawning, naming plow-gog", async () => {
    const d = device(okMinter(), gogPlugin());
    const r = jv(await run(d, ["gog", "gmail", "get", "1"]));
    expect(r.get("error").str).toContain("driven through plow-gog");
    expectNeverSpawned(d);
  });

  itSpawns("runs --help without minting a token", async () => {
    const mint = vi.fn(async () => TOKEN);
    const d = device(minterOf(mint), gogPlugin());
    const out = String(jv(await run(d, ["plow-gog", "gmail", "--help"])).get("output").str ?? "");
    expect(out).toContain("ARGV=--no-input --wrap-untrusted --enable-commands=gmail,calendar gmail --help");
    expect(mint).not.toHaveBeenCalled();
  });

  itSpawns("leaves a non-provider command completely alone", async () => {
    const mint = vi.fn(async () => TOKEN);
    const d = device(minterOf(mint), gogPlugin());
    const out = String(jv(await run(d, ["/bin/echo", "hello"])).get("output").str ?? "");
    expect(out).toContain("hello");
    expect(mint).not.toHaveBeenCalled();
  });

  it("publishes the skill only when the CLI it documents is staged", () => {
    expect(device(okMinter(), gogPlugin()).skills.manifest().map((s) => s.name)).toContain(
      "google-workspace",
    );
    // A skill for a binary this Mac does not have would teach an agent to run
    // commands that cannot work.
    expect(device(okMinter(), []).skills.manifest().map((s) => s.name)).not.toContain(
      "google-workspace",
    );
    // The input that discriminates per-plugin staging from "is anything
    // staged": a Mac with some OTHER plugin staged and no gog. Both cases
    // above pass under the old global check too.
    const otherRoot = tmp();
    fakePlugin(otherRoot, {
      ...GOG_MANIFEST,
      name: "other", command: "other",
      runtime: { binaries: [{ ...GOG_MANIFEST.runtime.binaries[0], name: "other" }] },
    }, "#!/bin/sh\n");
    expect(device(okMinter(), loadPlugins([otherRoot])).skills.manifest().map((s) => s.name)).not.toContain(
      "google-workspace",
    );
  });
});

/**
 * A bundled plugin with a manifest but NO provider row — the gap this PR
 * closes: reachable on the manifest alone, not a second dispatch system
 * beside providers.
 */
describe("a staged non-provider plugin through the exec path", () => {
  // The binary's staged name ("echo-bin") and the manifest's own command
  // ("echoer") are deliberately different strings: the agent's argv[0] is
  // "echoer" (matched by pluginFor against manifest.command), while the
  // entrypoint that must actually run is exec.argv[0] ("echo-bin"). If the
  // exec path ever resolved off the caller's argv[0] instead of the
  // manifest's own entrypoint, these two being the same string (as they
  // were before) would hide it.
  const ECHOER_MANIFEST = {
    name: "echoer", version: "test", command: "echoer",
    runtime: {
      binaries: [{
        name: "echo-bin", version: "test",
        url: { arm64: "https://example.invalid/e-arm64.tar.gz", x64: "https://example.invalid/e-x64.tar.gz" },
        sha256: { arm64: "0".repeat(64), x64: "0".repeat(64) },
      }],
    },
    exec: { argv: ["echo-bin", "--quiet"] },
    env: {}, argv: { read: [["say"]], write: [] },
    skill: "skill.md",
  };

  /** A staged echoer plugin whose binary runs `script`, with a skill.md the
   * manifest names (fakePlugin only stages the binary, not this). */
  function echoerPlugin(script: string): StagedPlugin[] {
    const root = tmp();
    const dir = fakePlugin(root, ECHOER_MANIFEST, script);
    fs.writeFileSync(
      path.join(dir, "skill.md"),
      "---\nname: echoer\ndescription: says things\n---\nSay what the owner asks.\n",
    );
    return loadPlugins([root]);
  }

  it("publishes the plugin's own manifest-declared skill only when it is staged", () => {
    expect(device(null, echoerPlugin("#!/bin/sh\n")).skills.manifest().map((s) => s.name)).toContain("echoer");
    expect(device(null, []).skills.manifest().map((s) => s.name)).not.toContain("echoer");
  });

  // A plugin's declared skill path can be unreadable (missing, or a
  // directory) or its frontmatter malformed — either way construction must
  // not throw, and the broken skill must not be published. Only "present and
  // valid" and "plugin absent" were covered before this.
  it.each([
    ["missing", (dir: string) => { /* never write skill.md */ void dir; }],
    ["malformed", (dir: string) => fs.writeFileSync(path.join(dir, "skill.md"), "not frontmatter at all")],
  ])("drops a plugin's declared skill when it is %s, without throwing", (_why, corrupt) => {
    const root = tmp();
    const dir = fakePlugin(root, ECHOER_MANIFEST, "#!/bin/sh\n");
    corrupt(dir);
    const plugins = loadPlugins([root]);
    let d!: DeviceAgent;
    expect(() => { d = device(null, plugins); }).not.toThrow();
    expect(d.skills.manifest().map((s) => s.name)).not.toContain("echoer");
  });

  it("refuses an argv the manifest does not allow, before spawning", async () => {
    const d = device(null, echoerPlugin('#!/bin/sh\necho SHOULD_NOT_RUN\n'));
    const r = jv(await run(d, ["echoer", "shout", "hi"]));
    expect(r.get("error").str).toContain("echoer allows: say");
    expectNeverSpawned(d);
  });

  itSpawns(
    "dispatches a staged non-provider plugin's command to its manifest entrypoint, and audits it",
    async () => {
      const plugins = echoerPlugin('#!/bin/sh\necho "ARGV=$*"\necho "CWD=$(pwd)"\n');
      const d = device(null, plugins);
      // The approved cwd stands in for what `mcp-server` would have resolved
      // and offered before the intent existed — this device enforces it
      // rather than substituting its own, so the test supplies it too.
      const out = String(
        jv(await run(d, ["echoer", "say", "hello"], 8000, undefined, plugins[0]!.dir)).get("output").str ?? "",
      );
      // The manifest's own belt (`--quiet`) leads the agent's argv, exactly
      // as plow-gog's does — proof the entrypoint resolved against the
      // staged tree, not PATH, and ran with the manifest's fixed prefix.
      expect(out).toContain("ARGV=--quiet say hello");
      // The run must resolve to the plugin's own staged
      // directory, not wherever the parent process happens to be running
      // (cwd: undefined would have handed the child the executor's scratch
      // dir instead). `plugin.dir` is canonical by construction — loadPlugins
      // resolves it once — so it compares directly against the child's pwd.
      expect(out).toContain(`CWD=${plugins[0]!.dir}`);
      const events = d.audit.entries().map((e) => jv(e).get("event").str);
      expect(events).toContain("exec_start");
      expect(events).toContain("exec_end");
    },
  );

  // The security property this pins: this device must never grant a wider
  // sandbox than the capability the owner approved. `mcp-server` always
  // offers the plugin's own directory as `cwd` (mcpServer.test.ts covers
  // that), but this device is the chokepoint and cannot rely on that — an
  // intent built some other way (a replay, a future caller) with a missing
  // or disagreeing `cwd` must be refused, never silently run in
  // `plugin.dir` regardless of what was approved.
  it("refuses to run when the approved cwd disagrees with the plugin's own directory, rather than substituting it", async () => {
    const plugins = echoerPlugin('#!/bin/sh\necho SHOULD_NOT_RUN\n');
    const d = device(null, plugins);
    const elsewhere = tmp();

    const r = jv(await run(d, ["echoer", "say", "hello"], 8000, undefined, elsewhere));

    expect(r.get("error").str).toContain("approved cwd does not match this plugin's own directory");
    expectNeverSpawned(d);
  });

  // The `wiki` shape: an entrypoint that is NOT one of the manifest's own
  // `runtime.binaries` (declares none at all here) — a tool this Mac reaches
  // through the executor's curated PATH, not something it staged. Joining it
  // under `binDir` would point at a file that was never staged there and
  // every invocation would ENOENT; observing the actual spawn (not reading
  // the code back) is what proves the relative entry was left alone instead.
  const RELAY_MANIFEST = {
    name: "relay", version: "test", command: "relay",
    runtime: { binaries: [] },
    exec: { argv: ["echo", "RELAY"] },
    env: {}, argv: { read: [["say"]], write: [] },
  };

  itSpawns(
    "leaves an entrypoint that names no staged binary relative, so the curated PATH resolves it",
    async () => {
      const root = tmp();
      const dir = fakePlugin(root, RELAY_MANIFEST, "#!/bin/sh\n"); // no binaries declared: no bin/ ever staged
      const d = device(null, loadPlugins([root]));
      const out = String(
        jv(await run(d, ["relay", "say", "hi"], 8000, undefined, fs.realpathSync(dir))).get("output").str ?? "",
      );
      // /bin/echo, found via the curated PATH (device()'s plugin has no
      // runtime/<arch>/bin at all, so a binDir join would have ENOENTed).
      expect(out).toContain("RELAY say hi");
      const events = d.audit.entries().map((e) => jv(e).get("event").str);
      expect(events).toContain("exec_start");
      expect(events).toContain("exec_end");
    },
  );

  // A `fixed` env source (wiki's WIKI_PATH among them) resolves for real — `${owner_home}` to the home
  // THIS device was built with, not the plugin's own directory and not some
  // other Mac's — and reaches the child's environment, and ONLY there.
  // Proven end to end through the real DeviceAgent, without printing the
  // value itself (providerExec's own token tests use the same shape): the
  // script reports its length, never its bytes, so a leak into argv, the
  // audit log, or the response would show up as the wrong length or the
  // value itself, either of which fails the assertions below.
  itSpawns(
    "resolves a fixed env source, ${owner_home} included, into the child's environment and nowhere else",
    async () => {
      const ownerHome = tmp();
      const resolved = path.join(ownerHome, "Plow", "wikish");
      const root = tmp();
      fakePlugin(
        root,
        {
          name: "envy", version: "test", command: "envy",
          runtime: { binaries: [] },
          exec: { argv: ["/bin/sh", "-c", 'echo "LEN=${#ENVY_PATH}"'] },
          env: { ENVY_PATH: { fixed: "${owner_home}/Plow/wikish" } },
          argv: { read: [["say"]], write: [] },
        },
        "#!/bin/sh\n",
      );
      const plugins = loadPlugins([root]);
      const d = new DeviceAgent(
        tmp(), "Test Mac", new HeadlessPolicy({ intent: "allow_once" }), null, ownerHome, null, plugins,
      );
      const response = await run(d, ["envy", "say", "hi"], 8000, undefined, plugins[0]!.dir);
      const out = String(jv(response).get("output").str ?? "");
      expect(out).toContain(`LEN=${resolved.length}`);
      expect(out).not.toContain(resolved);
      expect(JSON.stringify(response)).not.toContain(resolved);
      expect(fs.readFileSync(d.audit.file, "utf8")).not.toContain(resolved);
    },
  );
});

/**
 * DESIGN.md's stated contract for a plugin READ: one "always allow" covers
 * every later query, whatever its tail — the owner approves the pattern, not
 * the words. `PolicyEngine`'s rule view is what makes that true (see
 * `deviceAgent.ts`'s `pluginRuleView` and `plugins/argvRules.ts`'s
 * `ruleArgv`): only the STORED RULE sees the narrowed `<command> <prefix>`
 * view; the approval count, the audit log and the spawned argv all keep the
 * real, full argv throughout.
 */
describe("a plugin's always-allow rule, narrowed by argv shape", () => {
  const READ_WRITE_MANIFEST = {
    name: "kb", version: "test", command: "kb",
    runtime: {
      binaries: [{
        name: "kb-bin", version: "test",
        url: { arm64: "https://example.invalid/kb-arm64.tar.gz", x64: "https://example.invalid/kb-x64.tar.gz" },
        sha256: { arm64: "0".repeat(64), x64: "0".repeat(64) },
      }],
    },
    exec: { argv: ["kb-bin"] },
    env: {}, argv: { read: [["get"]], write: [["put"]] },
  };

  /** A counting delegate: always answers `always_allow`, and records every
   * intent it was actually asked to decide — the "was this prompted again?"
   * oracle, since a rule-answered intent never reaches `decideIntent` at all
   * (`PolicyEngine.decide`). */
  function countingAlwaysAllow(): { delegate: PolicyDelegate; asked: () => number } {
    let count = 0;
    return { delegate: { decideIntent: async () => { count += 1; return "always_allow"; } }, asked: () => count };
  }

  function kbDevice(delegate: PolicyDelegate): { device: DeviceAgent; dir: string } {
    const root = tmp();
    const dir = fakePlugin(root, READ_WRITE_MANIFEST, '#!/bin/sh\necho "ARGV=$*"\n');
    const plugins = loadPlugins([root]);
    return { device: new DeviceAgent(tmp(), "Test Mac", delegate, null, undefined, null, plugins), dir: plugins[0]!.dir };
  }

  itSpawns(
    "answers a sibling read query from the stored rule without re-prompting, keeping the full argv in the audit and the spawn",
    async () => {
      const { delegate, asked } = countingAlwaysAllow();
      const { device: d, dir } = kbDevice(delegate);

      const first = jv(await run(d, ["kb", "get", "alpha"], 8000, undefined, dir));
      expect(String(first.get("output").str ?? "")).toContain("ARGV=get alpha");
      expect(asked()).toBe(1);

      // A different query under the SAME prefix ("get") must be answered by
      // the stored rule, never re-asked — and must still run with its OWN
      // real argv, not the one that was approved first.
      const second = jv(await run(d, ["kb", "get", "beta"], 8000, undefined, dir));
      expect(String(second.get("output").str ?? "")).toContain("ARGV=get beta");
      expect(asked()).toBe(1);

      const received = d.audit
        .entries()
        .filter((e) => jv(e).get("event").str === "intent_received")
        .map((e) => (jv(e).get("capabilities").arr ?? []).join(","));
      expect(received[0]).toContain("get alpha");
      expect(received[1]).toContain("get beta");
    },
  );

  itSpawns.each<{ why: string; firstArgv: string[]; secondArgv: string[]; readPaths?: [string[], string[]] }>([
    {
      // Same prefix ("put"), different tail: a write is never narrowed, so
      // this must be decided fresh, not answered from the first's rule.
      why: "different arguments — one write's approval never authorises another",
      firstArgv: ["kb", "put", "alpha"],
      secondArgv: ["kb", "put", "beta"],
    },
    {
      // Same argv prefix ("get"), so the narrowed rule view sees an identical
      // process.exec capability — but a different approved fs.read path is a
      // materially different request. This must NOT be answered from the
      // first's rule: the owner who approved "read /tmp/a" never approved
      // "read /tmp/b", and the rule key including the full capability set
      // (not just the narrowed argv) is what keeps that true. This is
      // intentional — the fix for the over-prompt this guards is narrowing
      // WHAT the rule covers, never narrowing the key itself.
      why: "different read_paths — the rule key covers the whole capability set, not just the narrowed argv",
      firstArgv: ["kb", "get", "alpha"],
      secondArgv: ["kb", "get", "alpha"],
      readPaths: [["/tmp/a"], ["/tmp/b"]],
    },
  ])("still re-prompts a request carrying $why", async ({ firstArgv, secondArgv, readPaths }) => {
    const { delegate, asked } = countingAlwaysAllow();
    const { device: d, dir } = kbDevice(delegate);

    await run(d, firstArgv, 8000, readPaths?.[0], dir);
    expect(asked()).toBe(1);

    await run(d, secondArgv, 8000, readPaths?.[1], dir);
    expect(asked()).toBe(2);
  });
});

/**
 * The multi-account provider, end to end through the same exec path.
 *
 * The staged plugin's `gog` stands in for the real one: a script answering canned
 * `--json --results-only` output PER TOKEN, so every assertion is on the
 * merged JSON the agent gets back — which account's items arrived, tagged
 * how, degraded how — never on spawn order.
 */
describe("plow-gog through the exec path", () => {
  /**
   * A staged gog plugin whose binary answers canned JSON per GOG_ACCESS_TOKEN
   * — and, like the real 0.36.0 binary on a supplied token, first writes a
   * note to stderr. Every JSON-parsing path below runs against that note.
   */
  function plowGogPlugin(): StagedPlugin[] {
    return stagedGog(`#!/bin/sh
[ -n "$GOG_ACCESS_TOKEN" ] && echo "Note: Using direct access token (expires in ~1 hour; no auto-refresh)" >&2
case "$*" in
  *"calendar conflicts"*)
    case "$GOG_ACCESS_TOKEN" in
      tok-a) echo '[{"summary":"Standup"}]' ;;
      tok-cbad) exit 9 ;;
      *) echo '[]' ;;
    esac ;;
  *"calendar calendars"*) echo '[{"id":"primary","summary":"Calendar"}]' ;;
  *"calendar create"*) echo '{"created":"evt-1"}' ;;
  *"calendar events"*) echo '[{"summary":"argv: '"$*"'","start":"2026-01-01T00:00:00Z"}]' ;;
  *"gmail search"*)
    case "$GOG_ACCESS_TOKEN" in
      tok-a) echo '[{"id":"a1","date":"Mon, 16 Mar 2026 10:00:00 +0000"}]' ;;
      tok-b) echo '[{"id":"b1","date":"Wed, 18 Mar 2026 09:00:00 +0000"}]' ;;
      tok-slow) sleep 1; echo '[{"id":"s1","date":"Thu, 19 Mar 2026 09:00:00 +0000"}]' ;;
      tok-bad) echo "boom" >&2; exit 1 ;;
      tok-rejected) echo "sneakyagenttext" >&2; exit 2 ;;
      tok-expired) exit 4 ;;
      tok-empty) echo '[]' ;;
      tok-noresults) exit 3 ;;
      tok-quiet) ;;
    esac ;;
  *) echo "TOKEN=$GOG_ACCESS_TOKEN ARGV=$*" ;;
esac
`);
  }

  function accountsMinter(
    accounts: { account: string; token: string; isDefault: boolean }[],
    degraded: { account: string; reason: string }[] = [],
  ): Minter {
    return { mintAll: async () => ({ accounts, degraded }) };
  }

  const AB = [
    { account: "a@example.com", token: "tok-a", isDefault: true },
    { account: "b@example.com", token: "tok-b", isDefault: false },
  ];

  describe("calendar discovery", () => {
    afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

    itSpawns("lists calendars across connected accounts without an account flag", async () => {
      const d = device(accountsMinter(AB), plowGogPlugin());
      const response = await run(d, ["plow-gog", "calendar", "calendars", "--json", "--results-only"]);
      expect(response).toMatchObject({
        status: "completed",
        items: [
          { id: "primary", summary: "Calendar", account: "a@example.com" },
          { id: "primary", summary: "Calendar", account: "b@example.com" },
        ],
        degraded: [],
      });
    });

    itSpawns("lists calendars with an explicitly named account", async () => {
      const d = device(accountsMinter(AB), plowGogPlugin());
      const response = await run(d, ["plow-gog", "calendar", "calendars", "--json", "--results-only", "--account", "b@example.com"]);
      expect(jv(response).get("status").str).toBe("completed");
      expect(String(jv(response).get("output").str)).toContain('[{"id":"primary","summary":"Calendar"}]');
    });

    itSpawns("tags an accountless calendar list when only one account is connected", async () => {
      const d = device(accountsMinter([AB[0]!]), plowGogPlugin());
      const response = await run(d, ["plow-gog", "calendar", "calendars", "--json", "--results-only"]);
      expect(response).toMatchObject({
        status: "completed",
        items: [{ id: "primary", summary: "Calendar", account: "a@example.com" }],
        degraded: [],
      });
    });
  });

  itSpawns("fans a read out across accounts and returns one merged, tagged, sorted result", async () => {
    const d = device(accountsMinter(AB, [{ account: "c@example.com", reason: "needs_reauth" }]), plowGogPlugin());
    const response = await run(d, ["plow-gog", "gmail", "search", "q"]);
    expect(jv(response).get("status").str).toBe("completed");
    expect(response).toMatchObject({
      items: [
        { id: "b1", date: "Wed, 18 Mar 2026 09:00:00 +0000", account: "b@example.com" },
        { id: "a1", date: "Mon, 16 Mar 2026 10:00:00 +0000", account: "a@example.com" },
      ],
      // The mint's degraded accounts ride the result, so the agent can report
      // partial coverage instead of a false absence.
      degraded: [{ account: "c@example.com", reason: "needs_reauth" }],
    });
  });

  /**
   * The fan-out's audit disposition, one row per way a run can end.
   *
   * `exec_end` carries ONE number for N accounts, so the only question it can
   * answer is "did any account answer?" — counted over accounts, never over
   * items, and never over children: an account can fail at the mint without a
   * child existing, and a healthy account can answer with nothing in it.
   */
  itSpawns.each<{
    why: string;
    accounts: { account: string; token: string; isDefault: boolean }[];
    mintDegraded?: { account: string; reason: string }[];
    items: unknown[];
    degraded: { account: string; reason: string }[];
    exitZero: boolean;
    /** A child's own output, which must reach neither response nor audit. */
    forbidden?: string;
  }>([
    {
      why: "a partial failure keeps the healthy account's items and stays green",
      accounts: [AB[0]!, { account: "bad@example.com", token: "tok-bad", isDefault: false }],
      items: [{ id: "a1", account: "a@example.com" }],
      degraded: [{ account: "bad@example.com", reason: "gog exited 1" }],
      exitZero: true,
      forbidden: "boom",
    },
    {
      // gog maps Google's own failures onto its published exit table, so the
      // number is the diagnosis. `gog exited 2` alone left an owner unable to
      // tell a rejected request from an expired token.
      why: "every child failing names what each exit code meant, and is not green",
      accounts: [
        { account: "rejected@example.com", token: "tok-rejected", isDefault: true },
        { account: "expired@example.com", token: "tok-expired", isDefault: false },
      ],
      items: [],
      degraded: [
        { account: "rejected@example.com", reason: "gog rejected the request as invalid" },
        { account: "expired@example.com", reason: "that account needs re-auth — re-connect it in Plow" },
      ],
      exitZero: false,
      forbidden: "sneakyagenttext",
    },
    {
      // No child exists to read an exit code from; judging by children alone
      // called this green.
      why: "every account degraded at the mint is not green, though nothing ran",
      accounts: [],
      mintDegraded: [
        { account: "a@example.com", reason: "needs_reauth" },
        { account: "b@example.com", reason: "needs_reauth" },
      ],
      items: [],
      degraded: [
        { account: "a@example.com", reason: "needs_reauth" },
        { account: "b@example.com", reason: "needs_reauth" },
      ],
      exitZero: false,
    },
    {
      why: "a child that exits 0 with output that does not parse is not an answer",
      accounts: [{ account: "quiet@example.com", token: "tok-quiet", isDefault: true }],
      items: [],
      degraded: [{ account: "quiet@example.com", reason: "output was not JSON" }],
      exitZero: false,
    },
    {
      // Counting items rather than accounts marked this a failure — a partial
      // success wearing a failure's badge, and an empty calendar day is the
      // common case.
      why: "an account that answers with nothing is still an answer",
      accounts: [{ account: "a@example.com", token: "tok-empty", isDefault: true }],
      mintDegraded: [{ account: "b@example.com", reason: "needs_reauth" }],
      items: [],
      degraded: [{ account: "b@example.com", reason: "needs_reauth" }],
      exitZero: true,
    },
    {
      // gog's own "empty results" disposition, which `--fail-empty` asks for.
      // Counting it a failure marked an all-empty search red — the same
      // "nothing today" an exit-0 empty list carries, spelled as an exit code.
      why: "an account exiting 3 answered with nothing, and is not degraded",
      accounts: [{ account: "a@example.com", token: "tok-noresults", isDefault: true }],
      items: [],
      degraded: [],
      exitZero: true,
    },
    {
      // The branch the rule must not swallow: a mark that fires on an honest
      // empty answer is one an owner learns to ignore.
      why: "nothing found and nothing failed is a true zero",
      accounts: [{ account: "a@example.com", token: "tok-empty", isDefault: true }],
      items: [],
      degraded: [],
      exitZero: true,
    },
  ])("$why", async ({ accounts, mintDegraded, items, degraded, exitZero, forbidden }) => {
    const d = device(accountsMinter(accounts, mintDegraded ?? []), plowGogPlugin());
    const response = await run(d, ["plow-gog", "gmail", "search", "q"]);
    expect(response).toMatchObject({ status: "completed", items, degraded });
    if (forbidden !== undefined) {
      expect(JSON.stringify(response)).not.toContain(forbidden);
      expect(JSON.stringify(d.audit.entries())).not.toContain(forbidden);
    }
    expect(execEnd(d) === 0).toBe(exitZero);
  });

  itSpawns("waits out a fan-out child that outlives wait_ms instead of degrading it", async () => {
    // The per-account children have no public handle — the outer call owns
    // the only one — so a child left running at wait_ms must be waited out,
    // not converted to a degraded account with its output unretrievable.
    const d = device(
      accountsMinter([AB[0]!, { account: "slow@example.com", token: "tok-slow", isDefault: false }]),
      plowGogPlugin(),
    );
    const response = await run(d, ["plow-gog", "gmail", "search", "q"], 100);
    expect(response).toMatchObject({
      status: "completed",
      items: [
        { id: "s1", account: "slow@example.com" },
        { id: "a1", account: "a@example.com" },
      ],
      degraded: [],
    });
  });

  itSpawns("narrows a fan-out to the accounts --account names, and never forwards the flag", async () => {
    // AB plus a third account that is NOT named: it must not be queried, and
    // must not appear as degraded either — the agent did not ask about it.
    const d = device(
      accountsMinter([...AB, { account: "c@example.com", token: "tok-c", isDefault: false }]),
      plowGogPlugin(),
    );
    const response = await run(d, [
      "plow-gog", "calendar", "events", "list", "--account", "a@example.com,b@example.com", "--from=now",
    ]);
    expect(response).toMatchObject({ status: "completed", degraded: [] });
    const items = (response as { items: { account: string }[] }).items;
    expect(new Set(items.map((i) => i.account))).toEqual(new Set(["a@example.com", "b@example.com"]));
    // The fake echoes its argv for calendar events; the flag is not in it.
    expect(JSON.stringify(response)).not.toContain("--account");
  });

  itSpawns("carries a named-but-degraded account as degraded, and queries only the healthy one", async () => {
    const d = device(accountsMinter([AB[0]!], [{ account: "b@example.com", reason: "needs_reauth" }]), plowGogPlugin());
    const response = await run(d, ["plow-gog", "calendar", "events", "list", "--account=a@example.com,b@example.com"]);
    expect(response).toMatchObject({
      status: "completed",
      items: [{ account: "a@example.com" }],
      degraded: [{ account: "b@example.com", reason: "needs_reauth" }],
    });
  });

  it("rejects an --account entry that names no connected account, running nothing", async () => {
    const d = device(accountsMinter(AB), plowGogPlugin());
    const response = await run(d, ["plow-gog", "gmail", "search", "q", "--account=a@example.com,z@example.com"]);
    expect(jv(response).get("error").str).toMatch(/not a connected account/);
    expect(jv(response).get("error").str).toContain("a@example.com (default)");
    expectNeverSpawned(d);
  });

  itSpawns("narrows a fan-out read to one account with --account", async () => {
    const d = device(accountsMinter(AB), plowGogPlugin());
    const out = String(
      jv(await run(d, ["plow-gog", "gmail", "search", "q", "--account", "b@example.com"])).get("output").str ?? "",
    );
    expect(out).toContain("b1");
    expect(out).not.toContain("a1");
  });

  it("rejects an unknown --account, naming the connected accounts and never the caller's spelling", async () => {
    const d = device(accountsMinter(AB), plowGogPlugin());
    const response = await run(d, ["plow-gog", "gmail", "get", "m1", "--account", "z@example.com"]);
    const error = String(jv(response).get("error").str);
    expect(error).toContain("a@example.com");
    expect(error).toContain("b@example.com");
    expect(error).not.toContain("z@example.com");
    expectNeverSpawned(d);
  });

  it("refuses ANY accountless single with several accounts connected, stating the reply rule", async () => {
    const d = device(accountsMinter(AB), plowGogPlugin());
    // A send and an uncurated read alike: with more than one account there is
    // no silent default.
    for (const argv of [
      ["plow-gog", "gmail", "send", "--to", "x@y.com", "--subject", "s", "--body", "b"],
      ["plow-gog", "gmail", "get", "m1", "--json"],
    ]) {
      const response = await run(d, argv);
      const error = String(jv(response).get("error").str);
      expect(error).toContain("pass --account");
      expect(error).toContain("a@example.com (default)");
      expect(error).toContain("b@example.com");
      expect(error).toContain("received the thread");
    }
    expectNeverSpawned(d);
  });

  it("counts a degraded account as connected: an accountless op is refused, not rerouted", async () => {
    // The DEFAULT is degraded; the only healthy account is the secondary. An
    // accountless op silently running against it would answer from the wrong
    // mailbox — refuse, naming both.
    const d = device(
      accountsMinter(
        [{ account: "b@example.com", token: "tok-b", isDefault: false }],
        [{ account: "a@example.com", reason: "needs_reauth" }],
      ),
      plowGogPlugin(),
    );
    const response = await run(d, ["plow-gog", "gmail", "get", "m1"]);
    const error = String(jv(response).get("error").str);
    expect(error).toContain("pass --account");
    expect(error).toContain("b@example.com");
    expect(error).toContain("a@example.com (unavailable)");
    expectNeverSpawned(d);
  });

  it("rejects --account naming a degraded account with its reason, running nothing", async () => {
    const d = device(
      accountsMinter(AB, [{ account: "c@example.com", reason: "needs_reauth" }]),
      plowGogPlugin(),
    );
    const response = await run(d, ["plow-gog", "gmail", "get", "m1", "--account", "c@example.com"]);
    const error = String(jv(response).get("error").str);
    expect(error).toContain("cannot be used right now");
    expect(error).toContain("needs_reauth");
    expectNeverSpawned(d);
  });

  itSpawns("runs a write against the one named account, with --account stripped from gog's argv", async () => {
    const d = device(accountsMinter(AB), plowGogPlugin());
    const response = await run(d, [
      "plow-gog", "gmail", "send", "--to", "x@y.com", "--subject", "s", "--body", "b",
      "--account", "b@example.com",
    ]);
    const out = String(jv(response).get("output").str ?? "");
    expect(out).toContain("TOKEN=tok-b");
    expect(out).not.toContain("--account");
  });

  itSpawns("runs a write on the default account when it is the only one", async () => {
    const d = device(accountsMinter([AB[0]!]), plowGogPlugin());
    const response = await run(d, ["plow-gog", "gmail", "send", "--to", "x@y.com", "--subject", "s", "--body", "b"]);
    expect(String(jv(response).get("output").str ?? "")).toContain("TOKEN=tok-a");
  });

  itSpawns.each<{
    why: string;
    accounts: () => { account: string; token: string; isDefault: boolean }[];
    degraded?: { account: string; reason: string }[];
    extra: string[];
    expected: string;
  }>([
    {
      why: "a busy slot",
      accounts: () => AB,
      extra: ["--account", "a@example.com"],
      expected: "1 event(s) overlap",
    },
    {
      // The hole this chunk closes: the owner is busy on a calendar the
      // event is not being booked on, and the old probe never looked.
      why: "a conflict on a connected account the event is not booked on",
      accounts: () => AB,
      extra: ["--account", "b@example.com"],
      expected: "a@example.com: 1 event(s) overlap",
    },
    {
      why: "a probe that cannot answer",
      accounts: () => [{ account: "a@example.com", token: "tok-cbad", isDefault: true }],
      extra: [],
      expected: "could not check",
    },
    {
      // A check with a hole in it must not read as clear: the account the
      // mint could not reach was never checked either.
      why: "an account the mint could not reach",
      accounts: () => [AB[1]!],
      degraded: [{ account: "c@example.com", reason: "needs_reauth" }],
      extra: ["--account", "b@example.com"],
      expected: "c@example.com: could not check (needs_reauth)",
    },
  ])("refuses a timed create over $why, recorded as an error", async ({ accounts, degraded, extra, expected }) => {
    const d = device(accountsMinter(accounts(), degraded ?? []), plowGogPlugin());
    const response = await run(d, [
      "plow-gog", "calendar", "create", "primary", "--summary", "X",
      "--from", "2026-08-28T10:00:00Z", "--to", "2026-08-28T11:00:00Z", ...extra,
    ]);
    expect(jv(response).get("status").str).toBe("error");
    const error = String(jv(response).get("error").str);
    expect(error).toContain(expected);
    expect(error).toContain("--confirm-conflict");
    expect(error).not.toContain("to book anyway");
    // Who may confirm, and what may be named, is the served skill's rule, not this string's.
    expect(error).toContain("Follow the Google Workspace skill's conflict rule");
    const body = JSON.stringify(response);
    // The records themselves stay on the Mac: the owner approved a CREATE,
    // and event summaries riding its refusal would be an unapproved read.
    expect(body).not.toContain("Standup");
    // The create itself never ran: its output would have been the response.
    expect(body).not.toContain("evt-1");
    // And the audit says so: a refusal is an error row, never the zero-exit
    // exec_end the desktop renders green.
    const events = d.audit.entries().map((e) => jv(e).get("event").str);
    expect(events).toContain("exec_error");
    expect(events).not.toContain("exec_end");
  });

  itSpawns("books when every connected account is clear", async () => {
    const d = device(accountsMinter([AB[1]!]), plowGogPlugin());
    const response = await run(d, [
      "plow-gog", "calendar", "create", "primary", "--summary", "X",
      "--from", "2026-08-28T10:00:00Z", "--to", "2026-08-28T11:00:00Z",
    ]);
    expect(String(jv(response).get("output").str ?? "")).toContain("evt-1");
  });

  itSpawns("books anyway with --confirm-conflict", async () => {
    const d = device(accountsMinter(AB), plowGogPlugin());
    const response = await run(d, [
      "plow-gog", "calendar", "create", "primary", "--summary", "X",
      "--from", "2026-08-28T10:00:00Z", "--to", "2026-08-28T11:00:00Z",
      "--account", "a@example.com", "--confirm-conflict",
    ]);
    expect(String(jv(response).get("output").str ?? "")).toContain("evt-1");
  });

  itSpawns("skips the conflict check for an all-day create", async () => {
    // tok-a's conflicts answer is non-empty, so reaching the create at all
    // proves no probe ran.
    const d = device(accountsMinter(AB), plowGogPlugin());
    const response = await run(d, [
      "plow-gog", "calendar", "create", "primary", "--summary", "X",
      "--from", "2026-08-28", "--to", "2026-08-29", "--account", "a@example.com",
    ]);
    expect(String(jv(response).get("output").str ?? "")).toContain("evt-1");
  });

  it("answers the accounts verb from the mint, running nothing", async () => {
    const d = device(accountsMinter(AB, [{ account: "c@example.com", reason: "needs_reauth" }]), plowGogPlugin());
    const response = await run(d, ["plow-gog", "accounts"]);
    expect(response).toMatchObject({
      status: "completed",
      accounts: [
        { account: "a@example.com", is_default: true },
        { account: "b@example.com", is_default: false },
      ],
      degraded: [{ account: "c@example.com", reason: "needs_reauth" }],
    });
  });

  itSpawns("runs help without minting for any account", async () => {
    const mintAll = vi.fn(async () => ({ accounts: AB, degraded: [] }));
    const d = device({ mintAll }, plowGogPlugin());
    const out = String(jv(await run(d, ["plow-gog", "gmail", "--help"])).get("output").str ?? "");
    expect(out).toContain("ARGV=--no-input --wrap-untrusted --enable-commands=gmail,calendar gmail --help");
    expect(mintAll).not.toHaveBeenCalled();
  });

  it("reports a failed batch mint without spawning", async () => {
    const d = device(
      {
        mintAll: async () => {
          throw MintError.failed("plow-gog", "could not reach Plow");
        },
      },
      plowGogPlugin(),
    );
    const response = await run(d, ["plow-gog", "gmail", "search", "q"]);
    expect(jv(response).get("error").str).toMatch(/could not reach Plow/);
    expectNeverSpawned(d);
  });
});
