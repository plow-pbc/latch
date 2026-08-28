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

import {
  DeviceAgent,
  HeadlessPolicy,
  impliesNetwork,
  MintError,
  type Minter,
  type VendoredProvider,
} from "@domo/device-core";

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
function minterOf(mint: (provider: VendoredProvider) => Promise<string>): Minter {
  return {
    mintAll: async (provider) => ({
      accounts: [{ account: "a@example.com", token: await mint(provider), isDefault: true }],
      degraded: [],
    }),
  };
}

const okMinter = (): Minter => minterOf(async () => TOKEN);

function run(d: DeviceAgent, argv: string[], waitMs = 8000): Promise<JSONValue> {
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
    { wait_ms: waitMs },
  );
}

describe("a vendored provider through the exec path", () => {
  // Bare `gog` is the plow-gog provider (registry.ts); `gmail get` is a
  // single-account verb, so one account means one run and the child's own
  // output comes back — what these assert on.
  itSpawns("mints a token into the child's environment, and never into argv", async () => {
    const d = device(okMinter(), [vendorDir()]);
    const out = String(jv(await run(d, ["gog", "gmail", "get", "1"])).get("output").str ?? "");
    expect(out).toContain(`TOKEN=${TOKEN}`);
    // argv is world-readable through ps; the child's environment is not.
    expect(out).toContain("ARGV=");
    expect(out.split("ARGV=")[1]).not.toContain(TOKEN);
  });

  itSpawns("puts the belt in front of the command path", async () => {
    const d = device(okMinter(), [vendorDir()]);
    const out = String(jv(await run(d, ["gog", "gmail", "get", "1"])).get("output").str ?? "");
    expect(out).toContain("ARGV=--no-input --wrap-untrusted --enable-commands=gmail,calendar gmail get 1");
  });

  itSpawns("records the argv the OWNER approved, not the belted one", async () => {
    // The belt only ever narrows, and it is not what the human read.
    const d = device(okMinter(), [vendorDir()]);
    await run(d, ["gog", "gmail", "get", "1"]);
    const start = d.audit.entries().map((e) => JSON.stringify(e)).find((l) => l.includes("exec_start"))!;
    expect(start).toContain("gmail");
    expect(start).not.toContain("--wrap-untrusted");
  });

  it("refuses an argument that would disarm the belt, without minting or spawning", async () => {
    const mint = vi.fn(async () => TOKEN);
    const d = device(minterOf(mint), [vendorDir()]);
    const response = await run(d, ["gog", "gmail", "search", "q", "--wrap-untrusted=false"]);
    expect(jv(response).get("status").str).toBe("error");
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
    const d = device(make(), [vendorDir()]);
    const response = await run(d, ["gog", "gmail", "get", "1"]);
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
    const response = await run(d, ["gog", "gmail", "get", "1"]);
    expect(jv(response).get("error").str).toMatch(/not installed/);
    expect(mint).not.toHaveBeenCalled();
    expectNeverSpawned(d);
  });

  itSpawns("runs --help without minting a token", async () => {
    const mint = vi.fn(async () => TOKEN);
    const d = device(minterOf(mint), [vendorDir()]);
    const out = String(jv(await run(d, ["gog", "gmail", "--help"])).get("output").str ?? "");
    expect(out).toContain("ARGV=--no-input --wrap-untrusted --enable-commands=gmail,calendar gmail --help");
    expect(mint).not.toHaveBeenCalled();
  });

  itSpawns("leaves a non-provider command completely alone", async () => {
    const mint = vi.fn(async () => TOKEN);
    const d = device(minterOf(mint), [vendorDir()]);
    const out = String(jv(await run(d, ["/bin/echo", "hello"])).get("output").str ?? "");
    expect(out).toContain("hello");
    expect(mint).not.toHaveBeenCalled();
  });

  it("publishes the skill only when the CLI it documents is staged", () => {
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

/**
 * The multi-account provider, end to end through the same exec path.
 *
 * The vendored `gog` stands in for the real one: a script answering canned
 * `--json --results-only` output PER TOKEN, so every assertion is on the
 * merged JSON the agent gets back — which account's items arrived, tagged
 * how, degraded how — never on spawn order.
 */
describe("plow-gog through the exec path", () => {
  /**
   * A vendor dir whose `gog` answers canned JSON per GOG_ACCESS_TOKEN — and,
   * like the real 0.36.0 binary on a supplied token, first writes a note to
   * stderr. Every JSON-parsing path below runs against that note.
   */
  function plowVendorDir(): string {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, "gog"),
      `#!/bin/sh
[ -n "$GOG_ACCESS_TOKEN" ] && echo "Note: Using direct access token (expires in ~1 hour; no auto-refresh)" >&2
case "$*" in
  *"calendar conflicts"*)
    case "$GOG_ACCESS_TOKEN" in
      tok-a) echo '[{"summary":"Standup"}]' ;;
      tok-cbad) exit 9 ;;
      *) echo '[]' ;;
    esac ;;
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
      tok-quiet) ;;
    esac ;;
  *) echo "TOKEN=$GOG_ACCESS_TOKEN ARGV=$*" ;;
esac
`,
      { mode: 0o755 },
    );
    return dir;
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

  itSpawns("fans a read out across accounts and returns one merged, tagged, sorted result", async () => {
    const d = device(accountsMinter(AB, [{ account: "c@example.com", reason: "needs_reauth" }]), [
      plowVendorDir(),
    ]);
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

  itSpawns("degrades a failing account without losing the healthy one's items", async () => {
    const d = device(
      accountsMinter([AB[0]!, { account: "bad@example.com", token: "tok-bad", isDefault: false }]),
      [plowVendorDir()],
    );
    const response = await run(d, ["plow-gog", "gmail", "search", "q"]);
    expect(response).toMatchObject({
      status: "completed",
      items: [{ id: "a1", account: "a@example.com" }],
      degraded: [{ account: "bad@example.com", reason: "gog exited 1" }],
    });
    // The child's output is service-fetched text; only the exit code travels.
    expect(JSON.stringify(response)).not.toContain("boom");
    // A partial failure is still a run that answered: the audit stays green,
    // and the account that did not answer is named in the envelope.
    expect(execEnd(d)).toBe(0);
  });

  itSpawns("names what each exit code meant, without quoting the child", async () => {
    // gog maps Google's own failures onto its published exit table, so the
    // number is the diagnosis. `gog exited 2` alone left an owner unable to
    // tell a rejected request from an expired token.
    const d = device(
      accountsMinter([
        { account: "rejected@example.com", token: "tok-rejected", isDefault: true },
        { account: "expired@example.com", token: "tok-expired", isDefault: false },
      ]),
      [plowVendorDir()],
    );
    const response = await run(d, ["plow-gog", "gmail", "search", "q"]);
    expect(response).toMatchObject({
      status: "completed",
      items: [],
      degraded: [
        { account: "rejected@example.com", reason: "gog rejected the request as invalid" },
        { account: "expired@example.com", reason: "that account needs re-auth — re-connect it in Plow" },
      ],
    });
    expect(JSON.stringify(response)).not.toContain("sneaky");
    // Every account failed and nothing was retrieved: an exit-0 exec_end here
    // showed the run as green in the approval history with no items at all.
    expect(execEnd(d)).not.toBe(0);
  });

  itSpawns("marks a run that retrieved nothing non-zero even when no child ever ran", async () => {
    // Every account degraded at the MINT, so there is no child and no exit
    // code to read. Judging the run by its children called this green: the
    // question the audit answers is whether anything was retrieved, not where
    // the failure happened.
    const d = device(
      accountsMinter([], [
        { account: "a@example.com", reason: "needs_reauth" },
        { account: "b@example.com", reason: "needs_reauth" },
      ]),
      [plowVendorDir()],
    );
    const response = await run(d, ["plow-gog", "gmail", "search", "q"]);
    expect(response).toMatchObject({
      status: "completed",
      items: [],
      degraded: [
        { account: "a@example.com", reason: "needs_reauth" },
        { account: "b@example.com", reason: "needs_reauth" },
      ],
    });
    expect(execEnd(d)).not.toBe(0);
  });

  itSpawns("marks a run non-zero when every child exited 0 but nothing parsed", async () => {
    // The third way to retrieve nothing: the children ran and succeeded, and
    // their output was not JSON. Same verdict, for the same reason.
    const d = device(
      accountsMinter([{ account: "quiet@example.com", token: "tok-quiet", isDefault: true }]),
      [plowVendorDir()],
    );
    const response = await run(d, ["plow-gog", "gmail", "search", "q"]);
    expect(response).toMatchObject({
      status: "completed",
      items: [],
      degraded: [{ account: "quiet@example.com", reason: "output was not JSON" }],
    });
    expect(execEnd(d)).not.toBe(0);
  });

  itSpawns("leaves a genuinely empty result green: nothing failed, there was nothing to find", async () => {
    // The branch the rule above must not swallow. No events today is a true
    // zero, and marking it failed would train an owner to ignore the mark.
    const d = device(
      accountsMinter([{ account: "a@example.com", token: "tok-empty", isDefault: true }]),
      [plowVendorDir()],
    );
    const response = await run(d, ["plow-gog", "gmail", "search", "q"]);
    expect(response).toMatchObject({ status: "completed", items: [], degraded: [] });
    expect(execEnd(d)).toBe(0);
  });

  itSpawns("waits out a fan-out child that outlives wait_ms instead of degrading it", async () => {
    // The per-account children have no public handle — the outer call owns
    // the only one — so a child left running at wait_ms must be waited out,
    // not converted to a degraded account with its output unretrievable.
    const d = device(
      accountsMinter([AB[0]!, { account: "slow@example.com", token: "tok-slow", isDefault: false }]),
      [plowVendorDir()],
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
      [plowVendorDir()],
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
    const d = device(accountsMinter([AB[0]!], [{ account: "b@example.com", reason: "needs_reauth" }]), [
      plowVendorDir(),
    ]);
    const response = await run(d, ["plow-gog", "calendar", "events", "list", "--account=a@example.com,b@example.com"]);
    expect(response).toMatchObject({
      status: "completed",
      items: [{ account: "a@example.com" }],
      degraded: [{ account: "b@example.com", reason: "needs_reauth" }],
    });
  });

  it("rejects an --account entry that names no connected account, running nothing", async () => {
    const d = device(accountsMinter(AB), [plowVendorDir()]);
    const response = await run(d, ["plow-gog", "gmail", "search", "q", "--account=a@example.com,z@example.com"]);
    expect(jv(response).get("error").str).toMatch(/not a connected account/);
    expect(jv(response).get("error").str).toContain("a@example.com (default)");
    expectNeverSpawned(d);
  });

  itSpawns("narrows a fan-out read to one account with --account", async () => {
    const d = device(accountsMinter(AB), [plowVendorDir()]);
    const out = String(
      jv(await run(d, ["plow-gog", "gmail", "search", "q", "--account", "b@example.com"])).get("output").str ?? "",
    );
    expect(out).toContain("b1");
    expect(out).not.toContain("a1");
  });

  it("rejects an unknown --account, naming the connected accounts and never the caller's spelling", async () => {
    const d = device(accountsMinter(AB), [plowVendorDir()]);
    const response = await run(d, ["plow-gog", "gmail", "get", "m1", "--account", "z@example.com"]);
    const error = String(jv(response).get("error").str);
    expect(error).toContain("a@example.com");
    expect(error).toContain("b@example.com");
    expect(error).not.toContain("z@example.com");
    expectNeverSpawned(d);
  });

  it("refuses ANY accountless single with several accounts connected, stating the reply rule", async () => {
    const d = device(accountsMinter(AB), [plowVendorDir()]);
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
      [plowVendorDir()],
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
      [plowVendorDir()],
    );
    const response = await run(d, ["plow-gog", "gmail", "get", "m1", "--account", "c@example.com"]);
    const error = String(jv(response).get("error").str);
    expect(error).toContain("cannot be used right now");
    expect(error).toContain("needs_reauth");
    expectNeverSpawned(d);
  });

  itSpawns("runs a write against the one named account, with --account stripped from gog's argv", async () => {
    const d = device(accountsMinter(AB), [plowVendorDir()]);
    const response = await run(d, [
      "plow-gog", "gmail", "send", "--to", "x@y.com", "--subject", "s", "--body", "b",
      "--account", "b@example.com",
    ]);
    const out = String(jv(response).get("output").str ?? "");
    expect(out).toContain("TOKEN=tok-b");
    expect(out).not.toContain("--account");
  });

  itSpawns("runs a write on the default account when it is the only one", async () => {
    const d = device(accountsMinter([AB[0]!]), [plowVendorDir()]);
    const response = await run(d, ["plow-gog", "gmail", "send", "--to", "x@y.com", "--subject", "s", "--body", "b"]);
    expect(String(jv(response).get("output").str ?? "")).toContain("TOKEN=tok-a");
  });

  itSpawns.each([
    {
      why: "a busy slot",
      accounts: () => AB,
      extra: ["--account", "a@example.com"],
      expected: "1 event(s) overlap",
    },
    {
      why: "a probe that cannot answer",
      accounts: () => [{ account: "a@example.com", token: "tok-cbad", isDefault: true }],
      extra: [],
      expected: "could not check",
    },
  ])("refuses a timed create over $why, recorded as an error", async ({ accounts, extra, expected }) => {
    const d = device(accountsMinter(accounts()), [plowVendorDir()]);
    const response = await run(d, [
      "plow-gog", "calendar", "create", "primary", "--summary", "X",
      "--from", "2026-08-28T10:00:00Z", "--to", "2026-08-28T11:00:00Z", ...extra,
    ]);
    expect(jv(response).get("status").str).toBe("error");
    const error = String(jv(response).get("error").str);
    expect(error).toContain(expected);
    expect(error).toContain("--confirm-conflict");
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

  itSpawns("books anyway with --confirm-conflict", async () => {
    const d = device(accountsMinter(AB), [plowVendorDir()]);
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
    const d = device(accountsMinter(AB), [plowVendorDir()]);
    const response = await run(d, [
      "plow-gog", "calendar", "create", "primary", "--summary", "X",
      "--from", "2026-08-28", "--to", "2026-08-29", "--account", "a@example.com",
    ]);
    expect(String(jv(response).get("output").str ?? "")).toContain("evt-1");
  });

  it("answers the accounts verb from the mint, running nothing", async () => {
    const d = device(accountsMinter(AB, [{ account: "c@example.com", reason: "needs_reauth" }]), [
      plowVendorDir(),
    ]);
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
    const d = device({ mintAll }, [plowVendorDir()]);
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
      [plowVendorDir()],
    );
    const response = await run(d, ["plow-gog", "gmail", "search", "q"]);
    expect(jv(response).get("error").str).toMatch(/could not reach Plow/);
    expectNeverSpawned(d);
  });
});
