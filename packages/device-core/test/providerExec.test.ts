/**
 * The provider seam, end to end through the exec path.
 *
 * What matters is that a vendored CLI is authorised and run WITHOUT anything
 * tool-shaped: the capability is the argv the owner approved, the token never
 * touches it, and a refusal or a failed mint never spawns a child.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSONValue, jv, makeIntent } from "@domo/protocol";

import { DeviceAgent, HeadlessPolicy, impliesNetwork, MintError, type Minter } from "@domo/device-core";

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

/** A vendor dir whose `gog` reports the token it was handed and its own argv. */
function vendorDir(): string {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, "gog"),
    '#!/bin/sh\necho "TOKEN=$GOG_ACCESS_TOKEN ARGV=$*"\n',
    { mode: 0o755 },
  );
  return dir;
}

function device(minter: Minter | null, dirs: string[]): DeviceAgent {
  return new DeviceAgent(
    tmp(),
    "Test Mac",
    new HeadlessPolicy({ intent: "allow_once" }),
    null,
    undefined,
    minter,
    dirs,
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

const okMinter = (): Minter => ({ mint: async () => TOKEN });

function run(d: DeviceAgent, argv: string[]): Promise<JSONValue> {
  return d.handleIntent(
    makeIntent({
      agentId: "a1",
      agentDisplay: "Agent",
      deviceId: d.identity.deviceId,
      request: `run: ${argv.join(" ")}`,
      capabilities: [
        { kind: "process.exec", argv },
        // The SAME predicate `mcp-server` uses, not a second reading of it —
        // `needsToken` alone answers true for `/bin/echo`, which would have
        // approved network for an ordinary command here.
        { kind: "network", allowed: impliesNetwork(argv) },
      ],
      sessionId: "s1",
    }),
    { wait_ms: 8000 },
  );
}

describe("a vendored provider through the exec path", () => {
  itSpawns("mints a token into the child's environment, and never into argv", async () => {
    const d = device(okMinter(), [vendorDir()]);
    const out = String(jv(await run(d, ["gog", "gmail", "search", "q"])).get("output").str ?? "");
    expect(out).toContain(`TOKEN=${TOKEN}`);
    // argv is world-readable through ps; the child's environment is not.
    expect(out).toContain("ARGV=");
    expect(out.split("ARGV=")[1]).not.toContain(TOKEN);
  });

  itSpawns("puts the belt in front of the command path", async () => {
    const d = device(okMinter(), [vendorDir()]);
    const out = String(jv(await run(d, ["gog", "gmail", "search", "q"])).get("output").str ?? "");
    expect(out).toContain("ARGV=--no-input --wrap-untrusted --enable-commands=gmail,calendar gmail search q");
  });

  itSpawns("records the argv the OWNER approved, not the belted one", async () => {
    // The belt only ever narrows, and it is not what the human read.
    const d = device(okMinter(), [vendorDir()]);
    await run(d, ["gog", "gmail", "search", "q"]);
    const start = d.audit.entries().map((e) => JSON.stringify(e)).find((l) => l.includes("exec_start"))!;
    expect(start).toContain("gmail");
    expect(start).not.toContain("--wrap-untrusted");
  });

  it("refuses an argument that would disarm the belt, without minting or spawning", async () => {
    const mint = vi.fn(async () => TOKEN);
    const d = device({ mint }, [vendorDir()]);
    const response = await run(d, ["gog", "gmail", "search", "q", "--wrap-untrusted=false"]);
    expect(jv(response).get("status").str).toBe("error");
    expect(mint).not.toHaveBeenCalled();
    expectNeverSpawned(d);
  });

  it.each([
    [
      "a mint that failed",
      (): Minter => ({ mint: async () => { throw MintError.failed("gog", "could not reach Plow"); } }),
      /could not reach Plow/,
    ],
    ["no minter wired at all", (): Minter | null => null, /not paired/],
    // The arm that exists so an arbitrary thrown message never becomes the
    // response. Unreachable today — every path in the real minter throws
    // MintError — but it is the one place a body carrying a live credential
    // could reach the agent, so the row is worth its line.
    [
      "a minter that threw something else",
      (): Minter => ({ mint: async () => { throw new Error(TOKEN); } }),
      /could not authorise gog/,
    ],
  ])("reports %s without spawning", async (_why, make, expected) => {
    const d = device(make(), [vendorDir()]);
    const response = await run(d, ["gog", "gmail", "search", "q"]);
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
    const d = device({ mint }, []);
    const response = await run(d, ["gog", "gmail", "search", "q"]);
    expect(jv(response).get("error").str).toMatch(/not installed/);
    expect(mint).not.toHaveBeenCalled();
    expectNeverSpawned(d);
  });

  itSpawns("runs --help without minting a token", async () => {
    const mint = vi.fn(async () => TOKEN);
    const d = device({ mint }, [vendorDir()]);
    const out = String(jv(await run(d, ["gog", "gmail", "--help"])).get("output").str ?? "");
    expect(out).toContain("ARGV=--no-input --wrap-untrusted --enable-commands=gmail,calendar gmail --help");
    expect(mint).not.toHaveBeenCalled();
  });

  itSpawns("leaves a non-provider command completely alone", async () => {
    const mint = vi.fn(async () => TOKEN);
    const d = device({ mint }, [vendorDir()]);
    const out = String(jv(await run(d, ["/bin/echo", "hello"])).get("output").str ?? "");
    expect(out).toContain("hello");
    expect(mint).not.toHaveBeenCalled();
  });

  it("publishes the skill only when a CLI is staged", () => {
    expect(device(okMinter(), [vendorDir()]).skills.manifest().map((s) => s.name)).toContain(
      "google-workspace",
    );
    // A skill for a binary this Mac does not have would teach an agent to run
    // commands that cannot work.
    expect(device(okMinter(), []).skills.manifest().map((s) => s.name)).not.toContain(
      "google-workspace",
    );
    // The input that discriminates per-provider staging from "is anything
    // staged": a non-empty vendor dir with no gog in it, which is what a Mac
    // with only some OTHER provider staged looks like. Both cases above pass
    // under the old global check too.
    expect(device(okMinter(), [tmp()]).skills.manifest().map((s) => s.name)).not.toContain(
      "google-workspace",
    );
  });
});
