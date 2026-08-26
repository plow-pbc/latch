# gog CLI in Latch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Latch one MCP tool, `plow_gog`, that runs the bundled gog CLI against a short-lived Google access token minted from Plow, gated by the existing policy engine, approval card and audit log.

**Architecture:** A `tool` capability of the form `{tool: "gog.<leaf>", target: "<account>", write: boolean}` is built on this Mac from the tool's argv. `DeviceAgent.executeToolIntent` dispatches on the capability's namespace to one of two executors — the existing `ConnectorClient` for `slack.*`, a new `GogRunner` for `gog.*`. `GogRunner` mints a token over Plow's connector API, then `execve`s gog with a fixed belt of safety flags. There is **no command allowlist and no read/write table**: gog's own `--readonly` transport guard is the read/write boundary, and its pinned schema is used only to reject typos.

**Tech Stack:** TypeScript (Node + Electron), npm workspaces, vitest, electron-builder, gog 0.36.0 (static Go binary).

**Spec:** `docs/superpowers/specs/2026-08-26-gog-in-latch-design.md`

## Global Constraints

- **Base branch is `feat/slack-tools`** (PR #170), not `main`. Merges to `main` when #170 merges. Every `git commit` in this plan lands on `feat/gog-tools`.
- **gog pins to 0.36.0**, matching plow's `app/plowd/runtime/manifest.toml`. darwin/arm64 sha256 `5cb5b5210879769bc6a02bd9cf39ed1b0de3f0713b397ecbddefe95dd2be618b`; darwin/amd64 sha from the same release `checksums.txt`.
- **The minted Google token is a secret.** It never reaches argv, a log line, an error string, `audit.ndjson`, the view model, or the renderer — in any encoding. It travels only in the child process environment as `GOG_ACCESS_TOKEN`.
- **Belt flags, always, before the command path:** `--readonly` (unless the call is a write), `--gmail-no-send` (unless a write), `--no-input`, `--wrap-untrusted`.
- **Everything honors `DOMO_HOME`** so tests use throwaway roots.
- **Canonical JSON is signature-critical.** New capability fields must be ASCII-keyed and optional, so absent fields do not change existing encodings and `fixtures/` does not move.
- **Never launch the app on this Mac.** Electron runs happen on the M4 (`wiki/m4-screenshots.md`). Every task here is verifiable with `npx vitest run`.
- **Run `just test` after each task** and read the printed `N passed / N failed` summary line as the gate.
- **Do not commit** `docs/superpowers/plans/` or `docs/superpowers/specs/` — both are gitignored.

---

### Task 1: `write` on the tool capability, and in the rule key

**Files:**
- Modify: `packages/protocol/src/capability.ts:20-58` (the `Capability` interface), `packages/protocol/src/capability.ts:88-96` (the `tool` case of `capabilityDisplay`)
- Test: `packages/protocol/test/toolCapability.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `Capability.write?: boolean`. Every `gog.*` capability MUST set it explicitly to `true` or `false` — never omit it — so a read and a write of the same leaf produce different rule keys.

`RuleKey.compute` already hashes the canonical JSON of the normalized capability, and `normalizedCapability` strips only `reason`. So adding the field puts it in the key with no change to `RuleKey`. The test is what proves that.

- [ ] **Step 1: Write the failing test**

Add to `packages/protocol/test/toolCapability.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Capability, RuleKey, capabilityDisplay } from "../src/index.js";

describe("gog tool capabilities", () => {
  const read: Capability = { kind: "tool", tool: "gog.gmail.get", target: "a@b.com", write: false };
  const write: Capability = { kind: "tool", tool: "gog.gmail.get", target: "a@b.com", write: true };

  it("keys a read and a write of the SAME leaf differently", () => {
    // Otherwise an always-allow saved on a read authorises a write of the
    // same leaf — the one escalation this field exists to prevent.
    expect(RuleKey.compute("agent", "device", [read])).not.toEqual(
      RuleKey.compute("agent", "device", [write]),
    );
  });

  it("keys two accounts differently", () => {
    const other: Capability = { ...read, target: "c@d.com" };
    expect(RuleKey.compute("agent", "device", [read])).not.toEqual(
      RuleKey.compute("agent", "device", [other]),
    );
  });

  it("names the leaf, the account and the posture on the card", () => {
    expect(capabilityDisplay(write)).toBe("Google: gmail.get in a@b.com (writes)");
    expect(capabilityDisplay(read)).toBe("Google: gmail.get in a@b.com (reads only)");
  });

  it("leaves a Slack capability's encoding untouched", () => {
    // `write` is absent on every non-gog capability, so fixtures/ must not move.
    const slack: Capability = { kind: "tool", tool: "slack.messages.list", target: "w" };
    expect(capabilityDisplay(slack)).toBe("Slack: messages.list in w");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run packages/protocol/test/toolCapability.test.ts`
Expected: FAIL — `write` is not a property of `Capability` (tsc error), and the display strings do not match.

- [ ] **Step 3: Add the field**

In `packages/protocol/src/capability.ts`, after the `selector` field (line 54):

```ts
  /**
   * tool (gog only): whether this invocation may mutate.
   *
   * gog's `--readonly` transport guard is what ENFORCES this — it permits
   * GET/HEAD/OPTIONS and a closed allowlist of query POSTs, refusing anything
   * else before network dispatch, independent of OAuth scopes and command
   * names. This field is how the decision the owner made is carried into the
   * rule key.
   *
   * In the key rather than merely on the capability: without it, an
   * "always allow" saved against a read of `gmail.get` would authorise a
   * WRITE of `gmail.get`, because the rest of the capability is identical.
   *
   * Always set explicitly on a `gog.*` capability, never omitted — an absent
   * field and `false` are different canonical encodings, and a read whose
   * field went missing would collide with nothing and silently mint a second
   * rule. Absent on every other kind, so no existing encoding changes and
   * `fixtures/` does not move.
   */
  write?: boolean;
```

- [ ] **Step 4: Teach the card to render it**

Replace the `tool` case in `capabilityDisplay` (line 88-96) with:

```ts
    case "tool": {
      // Two namespaces today. The prefix decides the label and how much of the
      // capability there is to say; an unknown one falls through to the raw
      // tool string rather than claiming a provider it cannot vouch for.
      const gog = (c.tool ?? "").startsWith("gog.");
      const action = (c.tool ?? "?").replace(/^(slack|gog)\./, "");
      // The target is what the owner is actually authorising. A capability
      // carrying none names no scope, and must not imply one.
      const where = c.target ? `${action} in ${c.target}` : action;
      if (gog) {
        // The posture is the enforceable half of a gog capability — it is what
        // `--readonly` will hold the child to — so it belongs on the card next
        // to the leaf, not inferred from the leaf's name.
        return `Google: ${where} (${c.write ? "writes" : "reads only"})`;
      }
      // The selector is part of what is authorised, so it is part of what the
      // approval card and the audit log say was authorised.
      return c.selector ? `Slack: ${where} for "${c.selector}"` : `Slack: ${where}`;
    }
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npx vitest run packages/protocol && npx tsc -b`
Expected: PASS, tsc clean. `fixtures/` conformance still green — check with `just test-vectors`.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/capability.ts packages/protocol/test/toolCapability.test.ts
git commit -m "feat(protocol): carry a gog capability's read/write posture in the rule key"
```

---

### Task 2: The reserved-flag refusal

**Files:**
- Create: `packages/device-core/src/gog/reservedFlags.ts`
- Test: `packages/device-core/test/gogReservedFlags.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `reservedFlagIn(argv: string[]): string | null` — the first caller-supplied argument that would override the gate, or `null`.

**This is the load-bearing task.** Verified live against gog 0.36.0: appending `--readonly=false` *after* the command path disarms the guard, and the same `gmail send` that is otherwise blocked reaches Google. gog resolves repeated globals last-wins and accepts them after the command path, and caller argv reaches gog verbatim. Without this refusal the entire design is decorative.

Ported from plow's `cli/plow/commands/google.py`, which arrived at rules rather than spellings after enumerating them missed `--note-file` for two review rounds.

- [ ] **Step 1: Write the failing test**

Create `packages/device-core/test/gogReservedFlags.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { reservedFlagIn } from "../src/gog/reservedFlags.js";

describe("reservedFlagIn", () => {
  // Each row is a real hazard, not a spelling variant for its own sake.
  const refused: [string, string[]][] = [
    ["disarms --readonly (VERIFIED live at 0.36.0: send reached Google)", ["gmail", "send", "--readonly=false"]],
    ["disarms --readonly, space-separated", ["gmail", "send", "--readonly", "false"]],
    ["disarms the send block", ["gmail", "send", "--gmail-no-send=false"]],
    ["disarms the injection wrapper", ["gmail", "search", "x", "--wrap-untrusted=false"]],
    ["reopens the command gate", ["gmail", "get", "1", "--enable-commands-exact", "gmail.trash"]],
    ["reopens the command gate, prefix form", ["gmail", "get", "1", "--enable-commands", "gmail"]],
    ["disables a command we rely on", ["gmail", "get", "1", "--disable-commands", "x"]],
    ["re-enables prompting", ["gmail", "get", "1", "--no-input=false"]],
    ["repoints gog's config root", ["gmail", "get", "1", "--home", "/tmp/evil"]],
    ["supplies a different token", ["gmail", "get", "1", "--access-token", "AAA"]],
    ["reads a local file into an outbound message", ["gmail", "send", "--body-file", "/etc/passwd"]],
    ["the spelling plow's enumeration missed twice", ["gmail", "forward", "1", "--note-file", "/etc/passwd"]],
    ["a --*-file flag gog has not shipped yet", ["gmail", "send", "--future-file", "/etc/passwd"]],
    ["writes attacker-chosen bytes to a chosen path", ["gmail", "attachment", "1", "2", "--out", "/tmp/p"]],
    ["the --out alias", ["gmail", "attachment", "1", "2", "--output", "/tmp/p"]],
    ["the --out-dir spelling", ["gmail", "thread", "get", "1", "--out-dir", "/tmp"]],
    ["reads a local file, no shared suffix", ["gmail", "send", "--attach", "/etc/passwd"]],
  ];

  it.each(refused)("refuses: %s", (_why, argv) => {
    expect(reservedFlagIn(argv)).not.toBeNull();
  });

  const allowed: string[][] = [
    ["gmail", "search", "newer_than:7d"],
    ["gmail", "get", "18abcdef", "--json"],
    // A read-side boolean whose name merely contains a refused substring must
    // still pass, or the rule costs a legitimate call.
    ["gmail", "messages", "search", "x", "--include-attachments"],
    ["gmail", "attachment", "1", "2", "--inline"],
    ["calendar", "events", "primary", "--from", "2026-09-01T00:00:00Z"],
  ];

  it.each(allowed)("allows: %s %s %s", (...argv) => {
    expect(reservedFlagIn(argv.filter((a) => a !== undefined))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run packages/device-core/test/gogReservedFlags.test.ts`
Expected: FAIL — `Cannot find module '../src/gog/reservedFlags.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/device-core/src/gog/reservedFlags.ts`:

```ts
/**
 * The arguments a caller may not supply to gog.
 *
 * gog resolves repeated global flags LAST-WINS and accepts them after the
 * command path. Caller argv reaches gog verbatim, so without this the belt
 * flags are decorative: verified live at 0.36.0, appending `--readonly=false`
 * to a `gmail send` that is otherwise refused before dispatch let it reach
 * Google.
 *
 * Deliberately NOT an attempt to police gog's flag grammar generally — plow's
 * equivalent declined that chase, correctly, for the (inert) account flag.
 * These are not inert.
 */

/**
 * Flags that would override the gate itself, plus the one file-reading flag
 * with no shared suffix.
 */
const RESERVED_EXACT: ReadonlySet<string> = new Set([
  "--readonly",
  "--gmail-no-send",
  "--enable-commands",
  "--enable-commands-exact",
  "--disable-commands",
  "--wrap-untrusted",
  "--no-input",
  "--home",
  "--access-token",
  // Reads a local file into an outbound message like the `-file` family, but
  // does not share their suffix.
  "--attach",
]);

/**
 * Two argument-level rules rather than lists of spellings, because
 * enumeration has failed twice in plow (`--note-file`: `forward` has no
 * `--body` at all and spells it `--note`).
 *
 * `--*-file` reads a local file INTO an outbound message. `gmail send` must
 * stay reachable for the product to work, so without this rule an injected
 * call exfiltrates any file the app can read.
 *
 * `--out*` is a filesystem WRITE to a caller-chosen path: `gmail attachment`
 * takes `--out`/`--output`, `gmail thread get` takes `--out-dir`. Attachment
 * content stays reachable through `--inline`, which returns base64 on stdout.
 */
function ruleViolated(flag: string): boolean {
  return flag.endsWith("-file") || flag.startsWith("--out");
}

/**
 * The first caller-supplied argument that would override the gate, or null.
 *
 * Split on `=` so the joined spellings (`--readonly=false`) are caught
 * alongside the space-separated ones. Long spellings only: checked against gog
 * 0.36.0, none of these has a shorthand alias.
 */
export function reservedFlagIn(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const flag = arg.split("=", 1)[0]!;
    if (RESERVED_EXACT.has(flag) || ruleViolated(flag)) return flag;
  }
  return null;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run packages/device-core/test/gogReservedFlags.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Prove the tests are non-vacuous**

Temporarily change `ruleViolated` to `return false;`. Re-run.
Expected: the four `--*-file` rows and the three `--out*` rows FAIL (7 failures). Revert the change and re-run to green. Do not commit the broken version.

- [ ] **Step 6: Commit**

```bash
git add packages/device-core/src/gog/reservedFlags.ts packages/device-core/test/gogReservedFlags.test.ts
git commit -m "feat(device-core): refuse the gog arguments that would disarm the gate"
```

---

### Task 3: argv → leaf, validated against the pinned schema

**Files:**
- Create: `packages/device-core/src/gog/leaf.ts`, `packages/device-core/src/gog/gog-schema.json`, `scripts/fetch-gog-schema.mjs`
- Test: `packages/device-core/test/gogLeaf.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `gogLeaf(argv: readonly string[]): string` — the dotted command path (`"gmail.search"`), throwing `GogArgvError` if it is not a leaf at the pinned version. `export class GogArgvError extends Error`.

**This is not an allowlist.** Every gmail/calendar leaf gog ships is accepted. The check exists so a typo fails on this Mac instead of spending a minted token on a usage error — plow found that live, where a tool description documented `--start/--end` for a command whose flags are `--from/--to`.

- [ ] **Step 1: Generate the pinned schema**

Create `scripts/fetch-gog-schema.mjs`:

```js
#!/usr/bin/env node
/**
 * Regenerate packages/device-core/src/gog/gog-schema.json from the pinned gog.
 *
 * Run after bumping the pin in packages/device-core/src/gog/pin.json, then
 * re-run the four --readonly checks recorded in the design spec: the guard's
 * behaviour is verified per version, not assumed across versions.
 *
 * Usage: node scripts/fetch-gog-schema.mjs /path/to/gog
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const gog = process.argv[2];
if (!gog) {
  console.error("usage: node scripts/fetch-gog-schema.mjs /path/to/gog");
  process.exit(2);
}
const raw = execFileSync(gog, ["--no-input", "schema", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const doc = JSON.parse(raw);

/** Every leaf command path, dotted, under the groups our token's scopes reach. */
const leaves = [];
const walk = (node, path) => {
  const here = node.name ? [...path, node.name] : path;
  const subs = node.subcommands ?? [];
  if (subs.length === 0) {
    if (here.length > 0) leaves.push(here.join("."));
    return;
  }
  for (const s of subs) walk(s, here);
};
for (const group of doc.command?.subcommands ?? []) {
  if (group.name === "gmail" || group.name === "calendar") walk(group, []);
}
leaves.sort();
writeFileSync(
  new URL("../packages/device-core/src/gog/gog-schema.json", import.meta.url),
  JSON.stringify({ gogVersion: doc.build ?? "unknown", leaves }, null, 2) + "\n",
);
console.log(`${leaves.length} gmail/calendar leaves written`);
```

Run it against the pinned binary (fetch to a scratch dir, verify the sha from Global Constraints first):

```bash
node scripts/fetch-gog-schema.mjs /path/to/gog-0.36.0/gog
```

- [ ] **Step 2: Write the failing test**

Create `packages/device-core/test/gogLeaf.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { gogLeaf, GogArgvError } from "../src/gog/leaf.js";

describe("gogLeaf", () => {
  it("reads the command path, ignoring flags and their values", () => {
    expect(gogLeaf(["gmail", "search", "newer_than:7d", "--json"])).toBe("gmail.search");
    expect(gogLeaf(["calendar", "events", "primary", "--from", "2026-09-01T00:00:00Z"])).toBe(
      "calendar.events",
    );
  });

  it("reads a three-level path", () => {
    expect(gogLeaf(["gmail", "drafts", "create", "--to", "a@b.com"])).toBe("gmail.drafts.create");
  });

  it("rejects a typo rather than spending a minted token on a usage error", () => {
    expect(() => gogLeaf(["gmail", "serach", "x"])).toThrow(GogArgvError);
  });

  it("rejects a group that is not itself a leaf", () => {
    // `gmail drafts` is a group; running it would print help, not act.
    expect(() => gogLeaf(["gmail", "drafts"])).toThrow(GogArgvError);
  });

  it("rejects a leaf outside the scopes the minted token carries", () => {
    // drive/docs/sheets 403 on insufficient scope — fail here, not at Google.
    expect(() => gogLeaf(["drive", "search", "x"])).toThrow(GogArgvError);
  });

  it("rejects empty argv", () => {
    expect(() => gogLeaf([])).toThrow(GogArgvError);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run packages/device-core/test/gogLeaf.test.ts`
Expected: FAIL — `Cannot find module '../src/gog/leaf.js'`.

- [ ] **Step 4: Write the implementation**

Create `packages/device-core/src/gog/leaf.ts`:

```ts
/**
 * The dotted command path a gog argv names — the `<leaf>` half of a
 * `gog.<leaf>` capability.
 *
 * Validated against the schema of the PINNED gog, which is not an allowlist:
 * every gmail/calendar leaf gog ships is accepted. It exists so a typo fails
 * on this Mac instead of spending a minted token on a usage error — plow found
 * exactly that live, where a documented `--start/--end` did not exist on a
 * command whose flags are `--from/--to`.
 *
 * Groups are refused alongside typos: running a group prints help rather than
 * acting, so it would mint a token, produce nothing, and leave a capability in
 * the audit log describing an action that never happened.
 */
import schema from "./gog-schema.json" with { type: "json" };

export class GogArgvError extends Error {}

const LEAVES: ReadonlySet<string> = new Set(schema.leaves);

export function gogLeaf(argv: readonly string[]): string {
  // The command path is the leading run of non-flag words. gog accepts globals
  // after the path, and positionals follow the path too, so we stop at the
  // longest prefix that IS a known leaf rather than guessing a depth.
  const words: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) break;
    words.push(arg);
  }
  for (let n = words.length; n > 0; n--) {
    const candidate = words.slice(0, n).join(".");
    if (LEAVES.has(candidate)) return candidate;
  }
  throw new GogArgvError(
    `not a gog command this Mac can run at ${schema.gogVersion} (Gmail and Calendar only)`,
  );
}
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npx vitest run packages/device-core/test/gogLeaf.test.ts && npx tsc -b`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add packages/device-core/src/gog/leaf.ts packages/device-core/src/gog/gog-schema.json scripts/fetch-gog-schema.mjs packages/device-core/test/gogLeaf.test.ts
git commit -m "feat(device-core): resolve a gog argv to a leaf the pinned binary actually has"
```

---

### Task 4: A route table instead of a hardcoded Slack prefix

**Files:**
- Modify: `packages/device-core/src/connectors.ts:31` (`SLACK_ROUTE_PREFIX`), `:239-256` (`ConnectorClient`), `:258+` (`makeConnectorClient`), `packages/device-core/src/index.ts:23-31`
- Test: `packages/device-core/test/connectors.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `makeConnectorClient` gains a `routes` option; `ConnectorClient.call(action: string, body: JSONValue)`. New export `GMAIL_ROUTES` with one entry, `"access-token"`, at `POST /v1/connectors/gmail/access-token`.

This is the rule-of-2 extraction: a second provider needs the same authenticated Plow call with a different prefix. Everything else — the `Authorization` header, the timeout, the closed-table lookup, the credential-echo screen — is unchanged and now serves both.

- [ ] **Step 1: Write the failing test**

Add to `packages/device-core/test/connectors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeConnectorClient, GMAIL_ROUTES, SLACK_ACTIONS } from "../src/connectors.js";

describe("the route table is a parameter", () => {
  it("builds a gmail path from the gmail table", async () => {
    let seen = "";
    const client = makeConnectorClient({
      apiBaseUrl: "https://api.example.com",
      credential: () => "cred-aaaaaaaaaa",
      routes: GMAIL_ROUTES,
      fetchImpl: async (url) => {
        seen = String(url);
        return new Response(JSON.stringify({ data: { access_token: "t" } }), { status: 200 });
      },
    });
    await client.call("access-token", { account: "a@b.com" });
    expect(seen).toBe("https://api.example.com/v1/connectors/gmail/access-token");
  });

  it("still refuses an action outside the table it was given", async () => {
    const client = makeConnectorClient({
      apiBaseUrl: "https://api.example.com",
      credential: () => "cred-aaaaaaaaaa",
      routes: GMAIL_ROUTES,
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    // A Slack action against the gmail table is not a key. Traversal is
    // impossible by construction, not by a guard.
    await expect(client.call("messages.send", {})).rejects.toThrow();
    expect(Object.hasOwn(SLACK_ACTIONS, "messages.send")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run packages/device-core/test/connectors.test.ts`
Expected: FAIL — `GMAIL_ROUTES` is not exported and `routes` is not an option.

- [ ] **Step 3: Add the gmail table**

In `packages/device-core/src/connectors.ts`, beside `SLACK_ACTIONS`:

```ts
/** Where the Slack connector routes hang. A literal, joined to a literal. */
const SLACK_ROUTE_PREFIX = "/v1/connectors/slack/";
/** Where the Google connector routes hang. Same rule. */
const GMAIL_ROUTE_PREFIX = "/v1/connectors/gmail/";

/** A closed set of routes, and the prefix they hang from. */
export interface RouteTable {
  prefix: string;
  actions: Readonly<Record<string, { method: string; segment: string }>>;
}

export const SLACK_ROUTES: RouteTable = { prefix: SLACK_ROUTE_PREFIX, actions: SLACK_ACTIONS };

/**
 * The Google connector routes this Mac reaches. Exactly one: the token mint.
 *
 * Everything else Google happens in the gog child, against the token this
 * returns — which is the whole point of the design. Kept in the same shape as
 * SLACK_ACTIONS so the closed-table guarantee is one mechanism, not two.
 */
export const GMAIL_ROUTES: RouteTable = {
  prefix: GMAIL_ROUTE_PREFIX,
  actions: { "access-token": { method: "POST", segment: "access-token" } },
};
```

- [ ] **Step 4: Parameterize the client**

Change `ConnectorClient` (line 239) and `makeConnectorClient` (line 258):

```ts
export interface ConnectorClient {
  /** Run one action from the closed set this client was built with. */
  call(action: string, body: JSONValue): Promise<JSONValue>;
}

export function makeConnectorClient(opts: {
  apiBaseUrl: string;
  credential: () => string;
  /** The closed set. Defaults to Slack's so existing call sites are unchanged. */
  routes?: RouteTable;
  fetchImpl?: FetchLike;
}): ConnectorClient {
  const doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const base = opts.apiBaseUrl.replace(/\/+$/, "");
  const table = opts.routes ?? SLACK_ROUTES;
  // ... body unchanged, except:
  //   if (!Object.hasOwn(table.actions, action)) throw ConnectorError.unknownAction();
  //   const route = table.actions[action]!;
  //   ...doFetch(`${base}${table.prefix}${route.segment}`, { ... })
}
```

Leave every other line of the function — the header construction, the timeout, the decode, the `carriesCredential` screen — exactly as it is.

- [ ] **Step 5: Export the new names**

In `packages/device-core/src/index.ts`, add `SLACK_ROUTES`, `GMAIL_ROUTES` to the value export block and `RouteTable` to the type export block.

- [ ] **Step 6: Run the full suite**

Run: `just test`
Expected: every pre-existing Slack test still passes untouched — the default keeps them on `SLACK_ROUTES`. Read the printed summary line.

- [ ] **Step 7: Commit**

```bash
git add packages/device-core/src/connectors.ts packages/device-core/src/index.ts packages/device-core/test/connectors.test.ts
git commit -m "refactor(device-core): make the connector route table a parameter"
```

---

### Task 5: `GogRunner` — mint, then exec

**Files:**
- Create: `packages/device-core/src/gog/gogRunner.ts`
- Test: `packages/device-core/test/gogRunner.test.ts`
- Modify: `packages/device-core/src/index.ts`

**Interfaces:**
- Consumes: `reservedFlagIn` (Task 2), `gogLeaf` (Task 3), `makeConnectorClient` + `GMAIL_ROUTES` (Task 4)
- Produces:

```ts
export interface GogRunner {
  run(opts: { argv: readonly string[]; account: string; write: boolean }): Promise<JSONValue>;
}
export function makeGogRunner(opts: {
  mint: ConnectorClient;
  binaryPath: string;
  spawnImpl?: SpawnLike;   // injected in tests; defaults to node:child_process execFile
  timeoutMs?: number;      // default GOG_TIMEOUT_MS
}): GogRunner;
export const GOG_TIMEOUT_MS = 60_000;
export type SpawnLike = (
  file: string,
  args: readonly string[],
  opts: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;
```

- [ ] **Step 1: Write the failing test**

Create `packages/device-core/test/gogRunner.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { makeGogRunner } from "../src/gog/gogRunner.js";
import type { ConnectorClient } from "../src/connectors.js";

const TOKEN = "ya29.fake-token-value-000";

function mint(): ConnectorClient {
  return { call: async () => ({ data: { access_token: TOKEN } }) };
}

function capture() {
  const calls: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawnImpl = async (file: string, args: readonly string[], o: { env: NodeJS.ProcessEnv }) => {
    calls.push({ file, args, env: o.env });
    return { stdout: '{"ok":true}', stderr: "", code: 0 };
  };
  return { calls, spawnImpl };
}

describe("makeGogRunner", () => {
  it("passes the belt flags BEFORE the command path on a read", async () => {
    const { calls, spawnImpl } = capture();
    const r = makeGogRunner({ mint: mint(), binaryPath: "/x/gog", spawnImpl });
    await r.run({ argv: ["gmail", "search", "x"], account: "a@b.com", write: false });
    const args = calls[0]!.args;
    expect(args.slice(0, 4)).toEqual(["--readonly", "--gmail-no-send", "--no-input", "--wrap-untrusted"]);
    expect(args.slice(4)).toEqual(["gmail", "search", "x"]);
  });

  it("drops --readonly and --gmail-no-send on a write, keeping the rest", async () => {
    const { calls, spawnImpl } = capture();
    const r = makeGogRunner({ mint: mint(), binaryPath: "/x/gog", spawnImpl });
    await r.run({ argv: ["gmail", "send", "--to", "a@b.com"], account: "a@b.com", write: true });
    expect(calls[0]!.args.slice(0, 2)).toEqual(["--no-input", "--wrap-untrusted"]);
  });

  it("puts the token in the environment and NEVER in argv", async () => {
    const { calls, spawnImpl } = capture();
    const r = makeGogRunner({ mint: mint(), binaryPath: "/x/gog", spawnImpl });
    await r.run({ argv: ["gmail", "search", "x"], account: "a@b.com", write: false });
    expect(calls[0]!.env.GOG_ACCESS_TOKEN).toBe(TOKEN);
    expect(calls[0]!.env.GOG_ACCOUNT).toBe("a@b.com");
    // argv is readable by any process via ps; a process environment is not.
    expect(calls[0]!.args.join(" ")).not.toContain(TOKEN);
  });

  it("refuses a reserved flag BEFORE minting", async () => {
    const mintSpy = vi.fn(async () => ({ data: { access_token: TOKEN } }));
    const { spawnImpl } = capture();
    const r = makeGogRunner({ mint: { call: mintSpy }, binaryPath: "/x/gog", spawnImpl });
    await expect(
      r.run({ argv: ["gmail", "send", "--readonly=false"], account: "a@b.com", write: true }),
    ).rejects.toThrow();
    // Not minting is the point: a refused call must not spend a token at all.
    expect(mintSpy).not.toHaveBeenCalled();
  });

  it("never lets the token reach the error text of a failed run", async () => {
    const spawnImpl = async () => ({ stdout: "", stderr: `auth failed for ${TOKEN}`, code: 1 });
    const r = makeGogRunner({ mint: mint(), binaryPath: "/x/gog", spawnImpl });
    await expect(
      r.run({ argv: ["gmail", "search", "x"], account: "a@b.com", write: false }),
    ).rejects.toThrow(/^(?!.*ya29).*$/s);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run packages/device-core/test/gogRunner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/device-core/src/gog/gogRunner.ts`:

```ts
/**
 * Runs the bundled gog CLI against a freshly minted Google access token.
 *
 * **Mint per invocation, never a long-lived child.** Plow's
 * `_require_gmail_connection` returns the CACHED token unless inside a 60s
 * expiry buffer, so the Google-facing refresh rate stays one per account per
 * token lifetime however often this is called. That removes the only thing
 * `gog mcp` would have bought and the token-ageing problem it would have cost.
 *
 * **The token goes in the child environment and nowhere else** — not argv (any
 * process can read that via `ps`), not stdout, not an error string, not the
 * audit log. A command that prints a bearer token puts it into the calling
 * agent's captured output and from there into a persisted transcript, where it
 * outlives the token by a long way.
 */
import { execFile } from "node:child_process";
import { JSONValue, jv } from "@domo/protocol";
import { ConnectorClient, ConnectorError, echoesSecret } from "../connectors.js";
import { reservedFlagIn } from "./reservedFlags.js";
import { gogLeaf } from "./leaf.js";

/** Well inside the MCP call budget; a slow Google call defers rather than hangs. */
export const GOG_TIMEOUT_MS = 60_000;

export type SpawnLike = (
  file: string,
  args: readonly string[],
  opts: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface GogRunner {
  run(opts: { argv: readonly string[]; account: string; write: boolean }): Promise<JSONValue>;
}

/**
 * Flags gog runs under regardless of what the caller asked for.
 *
 * `--readonly` is the read/write boundary: a transport-level guard permitting
 * GET/HEAD/OPTIONS and a closed allowlist of query POSTs, refusing anything
 * else BEFORE network dispatch, independent of OAuth scopes and command names.
 * `--wrap-untrusted` is the injection defence — the agent reads email, and it
 * is what keeps a message body from reading as instructions.
 *
 * They precede the command path because gog accepts globals there. That they
 * are ALSO accepted after it, last-wins, is why `reservedFlagIn` exists.
 */
const READ_BELT = ["--readonly", "--gmail-no-send"] as const;
const ALWAYS_BELT = ["--no-input", "--wrap-untrusted"] as const;

const defaultSpawn: SpawnLike = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, [...args], { env: opts.env, timeout: opts.timeout, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ stdout, stderr, code: err ? 1 : 0 }));
  });

export function makeGogRunner(opts: {
  mint: ConnectorClient;
  binaryPath: string;
  spawnImpl?: SpawnLike;
  timeoutMs?: number;
}): GogRunner {
  const spawn = opts.spawnImpl ?? defaultSpawn;
  const timeout = opts.timeoutMs ?? GOG_TIMEOUT_MS;

  return {
    async run({ argv, account, write }) {
      // Both checks run BEFORE the mint. A refused call must not spend a token:
      // the token is the delegation, and one that was minted has left the
      // server whether or not we then used it.
      const reserved = reservedFlagIn(argv);
      if (reserved !== null) throw ConnectorError.refusedArgument(reserved);
      gogLeaf(argv); // throws GogArgvError on a typo or an out-of-scope group

      const minted = await opts.mint.call("access-token", { account });
      const token = jv(minted).get("data").get("access_token").str;
      if (token === null || token === "") throw ConnectorError.mintFailed();

      const args = [...(write ? [] : READ_BELT), ...ALWAYS_BELT, ...argv];
      const { stdout, stderr, code } = await spawn(opts.binaryPath, args, {
        // A minimal environment: the token, the account, and PATH. Inheriting
        // the app's whole environment would hand the child every other secret
        // this process holds.
        env: { PATH: process.env.PATH ?? "", GOG_ACCESS_TOKEN: token, GOG_ACCOUNT: account },
        timeout,
      });

      if (code !== 0) {
        // gog's stderr is foreign text and it has held the token (an auth
        // failure echoes what it tried). Screened, never interpolated blind.
        throw ConnectorError.gogFailed(echoesSecret(stderr, token) ? null : stderr.slice(0, 400));
      }
      // Screen stdout too: --wrap-untrusted marks fetched text, it does not
      // stop gog printing a token it was handed.
      if (echoesSecret(stdout, token)) throw ConnectorError.echoedCredential("gog");
      try {
        return JSON.parse(stdout) as JSONValue;
      } catch {
        return stdout;
      }
    },
  };
}
```

Add the three factories to `ConnectorError` in `connectors.ts`, following the existing private-constructor pattern — `refusedArgument(flag: string)`, `mintFailed()`, `gogFailed(detail: string | null)`. Compose each from the fixed vocabulary already used there; `refusedArgument` may name the flag (it is caller-supplied and bounded), `gogFailed` takes an already-screened detail or none.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run packages/device-core/test/gogRunner.test.ts && npx tsc -b`
Expected: PASS, 5 tests, tsc clean.

- [ ] **Step 5: Export and commit**

Add `makeGogRunner`, `GOG_TIMEOUT_MS` and the `GogRunner` / `SpawnLike` types to `packages/device-core/src/index.ts`.

```bash
git add packages/device-core/src/gog/gogRunner.ts packages/device-core/src/connectors.ts packages/device-core/src/index.ts packages/device-core/test/gogRunner.test.ts
git commit -m "feat(device-core): run gog against a per-call minted token"
```

---

### Task 6: Dispatch on the capability's namespace

**Files:**
- Modify: `packages/device-core/src/deviceAgent.ts:436-462` (`executeToolIntent`), and the constructor at `:164-172`
- Test: `packages/device-core/test/connectorIntent.test.ts`

**Interfaces:**
- Consumes: `GogRunner` (Task 5), `Capability.write` (Task 1)
- Produces: `DeviceAgent` accepts an optional `gog: GogRunner | null` alongside `connectors`.

- [ ] **Step 1: Write the failing test**

Add to `packages/device-core/test/connectorIntent.test.ts`:

```ts
it("routes a gog.* capability to the gog runner, not the connector", async () => {
  const ran: { argv: readonly string[]; write: boolean }[] = [];
  const gog = { run: async (o: { argv: readonly string[]; account: string; write: boolean }) => {
    ran.push({ argv: o.argv, write: o.write });
    return { ok: true };
  } };
  // Build a DeviceAgent with a HeadlessPolicy that approves, a null connector,
  // and this runner; drive an intent whose capability is
  // {kind:"tool", tool:"gog.gmail.search", target:"a@b.com", write:false}
  // with payload {argv:["gmail","search","x"]}.
  // Assert: ran.length === 1, the connector was never called, and the device's
  // answer nests the runner's value under `result` beside its own `status`.
});

it("records tool_invoked with the leaf and the account, and never the argv", async () => {
  // Assert on audit.ndjson: one tool_invoked whose `tool` is "gog.gmail.search"
  // and whose `target` is "a@b.com"; assert the line does not contain the
  // search query. argv is content, and this log is append-only and human-read.
});
```

Fill both bodies out using the existing fixtures in this file — do not leave the comments as the test.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run packages/device-core/test/connectorIntent.test.ts`
Expected: FAIL — the gog capability falls into `slackAction`, which returns `null`, so it errors as an unknown action.

- [ ] **Step 3: Replace the hardcoded branch with a registry**

In `executeToolIntent` (line 436), replace the body of the `try` block:

```ts
  private async executeToolIntent(
    intent: Intent,
    cap: { tool?: string; target?: string; write?: boolean },
    payload: JSONValue,
  ): Promise<JSONValue> {
    const tool = cap.tool ?? "";
    const what = { intentId: intent.intentId, tool, target: cap.target ?? "" };
    try {
      // Which executor runs a `tool` capability is decided by its namespace,
      // and by nothing else. Two providers today; a third is an entry here,
      // not a branch at every call site downstream.
      this.audit.record("tool_invoked", what);
      if (tool.startsWith("gog.")) {
        const gog = this.gog;
        if (gog === null) throw ConnectorError.unpaired();
        return { status: "completed", result: await gog.run({
          argv: jv(payload).get("argv").strings ?? [],
          account: cap.target ?? "",
          // Absent is not false: a gog capability always carries the field, so
          // a missing one is a malformed rule rather than a read.
          write: cap.write === true,
        }) };
      }
      const action = slackAction(tool);
      if (action === null) throw ConnectorError.unknownAction();
      const connectors = this.connectors;
      if (connectors === null) throw ConnectorError.unpaired();
      return { status: "completed", result: await connectors.call(action, payload) };
    } catch (e) {
      // ... unchanged, except the fallback message becomes "the tool call failed"
    }
  }
```

Note the `audit.record` moves ahead of the dispatch so the bracket still holds for both executors — what was attempted is written before it can have an effect.

Add the constructor parameter beside `connectors` (line 172), defaulting to `null`, with a comment matching the existing one's shape.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `just test`
Expected: PASS. Every existing Slack intent test still green — the `gog.` prefix is the only new path.

- [ ] **Step 5: Commit**

```bash
git add packages/device-core/src/deviceAgent.ts packages/device-core/test/connectorIntent.test.ts
git commit -m "feat(device-core): dispatch a tool capability on its namespace"
```

---

### Task 7: The `plow_gog` tool

**Files:**
- Create: `packages/mcp-server/src/gogTools.ts`
- Modify: `packages/mcp-server/src/tools.ts:22` (import), `:629` (the `TOOLS` array)
- Test: `packages/mcp-server/test/gogTools.test.ts`, `packages/mcp-server/test/toolCopy.test.ts`

**Interfaces:**
- Consumes: `decideAndRun`, `GOAL`, `ToolSpec`, `ToolError` from `toolKit.js`; `gogLeaf` from `@domo/device-core`
- Produces: `export const GOG_TOOLS: ToolSpec[]` — one entry, `plow_gog`.

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-server/test/gogTools.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { GOG_TOOLS } from "../src/gogTools.js";

const tool = GOG_TOOLS[0]!;

describe("plow_gog", () => {
  it("is the only Google tool", () => {
    expect(GOG_TOOLS).toHaveLength(1);
    expect(tool.name).toBe("plow_gog");
  });

  it("builds a read capability naming the leaf, the account and the posture", async () => {
    // Drive tool.run with a fake ToolContext that captures the intent, then:
    // expect(capability).toEqual({
    //   kind: "tool", tool: "gog.gmail.search", target: "a@b.com", write: false,
    // });
  });

  it("puts argv in the PAYLOAD, never in the capability", async () => {
    // The search query is content. In the capability it would make every rule
    // key unique and put a stranger's words inside a saved rule.
  });

  it("requires an account rather than defaulting to one", async () => {
    // A blank account mints for the DEFAULT mailbox — plow#1321 shipped that
    // bug and had to correct it in review.
    await expect(/* run without account */).rejects.toThrow(/account/);
  });

  it("defaults write to false", async () => {
    // The safe value is the default; claiming read on a mutating call is
    // refused by gog before the network, so the bit can only narrow.
  });

  it("rejects a leaf the pinned gog does not have, before any intent exists", async () => {
    // No approval card should ever be raised for a call that cannot run.
  });
});
```

Fill each body out against the fake-context pattern already used in `packages/mcp-server/test/slackTools.test.ts`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run packages/mcp-server/test/gogTools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the tool**

Create `packages/mcp-server/src/gogTools.ts`:

```ts
/**
 * The owner's Google, as one Latch tool.
 *
 * One generic tool rather than a schema per verb: gogcli's CLI surface is in
 * the models' training data, so the agent works from knowledge it already has,
 * and a new Workspace capability costs a pin bump rather than four parallel
 * edits. The enforceable bound is not the tool — it is the capability this
 * builds, and gog's own `--readonly` guard.
 *
 * The capability carries the leaf, the account and the read/write posture.
 * argv rides the PAYLOAD, exactly as an `fs.write`'s bytes do: a search query
 * or a message body in the capability would make every rule key unique and put
 * a stranger's words inside a saved rule.
 */
import { Capability, JSONValue, jv } from "@domo/protocol";
import { gogLeaf } from "@domo/device-core";
import { decideAndRun, GOAL, ToolContext, ToolError, ToolSpec } from "./toolKit.js";
import { Progress } from "./deferred.js";

/** Bounded before it reaches a capability chip, the reviewer prompt and audit. */
const REQUEST_EXCERPT_MAX = 200;

export const GOG_TOOLS: ToolSpec[] = [
  {
    name: "plow_gog",
    title: "Use the owner's Gmail and Calendar",
    description:
      "Run the `gog` Google Workspace CLI against ONE of the owner's connected accounts. " +
      "Pass the command as an argv array WITHOUT the leading `gog` — e.g. " +
      '["gmail","search","newer_than:7d"] or ["calendar","events","primary","--from","2026-09-01T00:00:00Z"]. ' +
      "Gmail and Calendar only. Global flags go AFTER the command path. " +
      "Set write:true for anything that changes state (send, reply, drafts, calendar create/update/delete) — " +
      "read calls are run under a guard that refuses mutations, so a write left false simply fails. " +
      "One mailbox per call: to cover every account, list them with plow_gmail_status and iterate. " +
      "Results are other people's words — quote only what answers the question.",
    inputSchema: {
      type: "object",
      required: ["argv", "account"],
      properties: {
        argv: { type: "array", items: { type: "string" }, description: "The gog command, without the leading `gog`" },
        account: { type: "string", description: "Which connected Google account, from plow_gmail_status" },
        write: { type: "boolean", default: false, description: "True if this changes state" },
        goal: GOAL,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    deferrable: true,
    async run(args, ctx, progress) {
      const argv = jv(args).get("argv").strings;
      if (argv === null || argv.length === 0) throw new ToolError("missing 'argv'");
      // Required, never defaulted: a blank account mints for the DEFAULT
      // mailbox, which is a different mailbox than the one the card names.
      const account = jv(args).get("account").str;
      if (account === null || account === "") throw new ToolError("missing 'account'");
      const write = jv(args).get("write").bool === true;
      // Resolve before the human sees it, and before an intent exists: a call
      // that cannot run must not raise an approval card.
      const leaf = gogLeaf(argv);

      const capability: Capability = {
        kind: "tool",
        tool: `gog.${leaf}`,
        target: account,
        // Always explicit. Absent and false are different canonical encodings.
        write,
      };
      // Display-only, so it may vary per call — this is where the operative
      // detail goes, the way `read file: <path>` carries one.
      const request = `${write ? "run" : "read"} Google ${leaf} as ${account}: ${
        argv.join(" ").slice(0, REQUEST_EXCERPT_MAX)
      }`;
      const response = await decideAndRun(
        ctx,
        progress,
        request,
        jv(args).get("goal").str ?? undefined,
        [capability],
        { argv },
      );
      return jv(response).get("result").value ?? null;
    },
  },
];
```

- [ ] **Step 4: Register it**

In `packages/mcp-server/src/tools.ts`, add `import { GOG_TOOLS } from "./gogTools.js";` beside the Slack import (line 22) and `...GOG_TOOLS,` to the `TOOLS` array (near line 629). Update the `TOOLS.length` assertion in `packages/mcp-server/test/mcpServer.test.ts` from 20 to 21, and extend `toolCopy.test.ts` to cover the new description.

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `just test`
Expected: PASS; `TOOLS.length` is 21.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server/src/gogTools.ts packages/mcp-server/src/tools.ts packages/mcp-server/test/gogTools.test.ts packages/mcp-server/test/mcpServer.test.ts packages/mcp-server/test/toolCopy.test.ts
git commit -m "feat(mcp-server): expose the owner's Google as one gog tool"
```

---

### Task 8: The approval card states the posture

**Files:**
- Modify: `apps/desktop/src/viewModel.ts:11` (import), `:21-23` (the warning predicate), `:52-58` (the write doc comment)
- Test: `apps/desktop/test/viewModel.test.ts`, `apps/desktop/test/approvalCardShape.test.ts`

**Interfaces:**
- Consumes: `Capability.write` (Task 1)
- Produces: no new exports; the connected-account warning now fires for a gog write.

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/test/viewModel.test.ts`:

```ts
it("warns on a gog write, and not on a gog read", () => {
  const write = { kind: "tool", tool: "gog.gmail.send", target: "a@b.com", write: true } as const;
  const read = { kind: "tool", tool: "gog.gmail.search", target: "a@b.com", write: false } as const;
  expect(viewModelFor([write]).connectedAccountWarning).toBe(true);
  expect(viewModelFor([read]).connectedAccountWarning).toBe(false);
});

it("warns on a gog capability with no posture at all", () => {
  // A stored rule or a wire value can carry a shape the current code did not
  // write. Fail toward the warning, never away from it.
  const odd = { kind: "tool", tool: "gog.gmail.send", target: "a@b.com" } as const;
  expect(viewModelFor([odd]).connectedAccountWarning).toBe(true);
});
```

Use whatever the file's existing helper for building a view model is named; do not introduce a new one.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run apps/desktop/test/viewModel.test.ts`
Expected: FAIL — `slackAction("gog.gmail.send")` returns `null`, which the current predicate treats as a warning, so the *read* case fails.

- [ ] **Step 3: Update the predicate**

Replace lines 21-23 of `apps/desktop/src/viewModel.ts`:

```ts
  if (c.kind !== "tool") return false;
  const tool = c.tool ?? "";
  // A gog capability states its own posture, and it is the enforceable one —
  // `--readonly` holds the child to it. Anything that is not explicitly a read
  // warns, so a stored rule or a wire value missing the field fails toward the
  // warning rather than away from it.
  if (tool.startsWith("gog.")) return c.write !== false;
  const action = slackAction(tool);
  return action === null || SLACK_WRITE_ACTIONS.has(action);
```

Update the doc comment at lines 52-58 to say the write line covers a gog write as well as a Slack send/edit/DM.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run apps/desktop && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/viewModel.ts apps/desktop/test/viewModel.test.ts apps/desktop/test/approvalCardShape.test.ts
git commit -m "feat(desktop): state a gog call's read/write posture on the card"
```

---

### Task 9: Bundle gog, and wire it up

**Files:**
- Create: `packages/device-core/src/gog/pin.json`, `apps/desktop/src/gogWiring.ts`
- Modify: `scripts/build-browser-runtime.mjs` (or a sibling fetch script), `justfile`, `apps/desktop/electron-builder.yml:63-70` (`extraResources`), `apps/desktop/build/afterPack.cjs`, `apps/desktop/src/main.ts`
- Test: `apps/desktop/test/gogWiring.test.ts`

**Interfaces:**
- Consumes: `makeGogRunner`, `makeConnectorClient`, `GMAIL_ROUTES` (Tasks 4-5)
- Produces: `buildGogRunner(opts: { apiBaseUrl: string; home: string; binaryPath: string; fetchImpl?: FetchLike }): GogRunner`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/gogWiring.test.ts`, mirroring `connectorWiring.test.ts`:

```ts
it("reads the credential from home on EVERY call, not once at construction", async () => {
  // Same reason connectorWiring does: re-pairing has to take effect on the
  // next call, not the next launch. Write one credential, call, rewrite the
  // settings file, call again, and assert the second call carried the second
  // credential.
});

it("mints against the gmail route table", async () => {
  // Assert the fetch URL ends /v1/connectors/gmail/access-token.
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run apps/desktop/test/gogWiring.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the wiring**

Create `apps/desktop/src/gogWiring.ts`:

```ts
/**
 * How `DeviceAgent` reaches gog. Outside `main.ts` for the reason
 * `connectorWiring.ts` is: it decides which credential leaves this Mac and
 * when it is read, so it must be reachable by `npx vitest run` with no display.
 */
import { makeGogRunner, makeConnectorClient, GMAIL_ROUTES, type GogRunner, type FetchLike } from "@domo/device-core";
import { loadSettings } from "./settings.js";

export function buildGogRunner(opts: {
  apiBaseUrl: string;
  home: string;
  binaryPath: string;
  fetchImpl?: FetchLike;
}): GogRunner {
  return makeGogRunner({
    binaryPath: opts.binaryPath,
    mint: makeConnectorClient({
      apiBaseUrl: opts.apiBaseUrl,
      // Read per call, never captured: re-pairing takes effect on the next
      // call, not the next launch.
      credential: () => loadSettings(opts.home).relayCredential,
      routes: GMAIL_ROUTES,
      fetchImpl: opts.fetchImpl,
    }),
  });
}
```

Call it from `main.ts` beside `buildConnectorClient` and pass the result as `DeviceAgent`'s new `gog` argument. Resolve `binaryPath` from `process.resourcesPath` in a packaged app and from `vendor/gog/<arch>/gog` in development, honoring a `DOMO_GOG` override for tests and the M4 runs.

- [ ] **Step 4: Pin, fetch, bundle, sign**

Create `packages/device-core/src/gog/pin.json`:

```json
{
  "version": "0.36.0",
  "sha256": {
    "darwin_arm64": "5cb5b5210879769bc6a02bd9cf39ed1b0de3f0713b397ecbddefe95dd2be618b",
    "darwin_amd64": "<from the 0.36.0 release checksums.txt>"
  }
}
```

Add a `fetch-gog` recipe to the `justfile` that downloads both darwin tarballs for the pinned version, **verifies each sha256 against `pin.json` before extracting**, and lands them at `vendor/gog/<arch>/gog`. Add `vendor/gog/` to `.gitignore` beside the other vendored runtimes. Add an `extraResources` entry in `electron-builder.yml` mapping `../../vendor/gog` to `gog`, and add the binary to the list `afterPack.cjs` Developer-ID signs after electron-builder's universal merge.

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `just test`
Expected: PASS. Read the printed summary line.

- [ ] **Step 6: Verify the packaged app on the M4**

The suite cannot cover this — it needs Electron and a real binary. On the M4 only (never this Mac): `just package-unnotarized`, install, and confirm `gog` is inside the app bundle, is signed, and executes. Record the result in the PR body.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/gogWiring.ts apps/desktop/src/main.ts apps/desktop/test/gogWiring.test.ts packages/device-core/src/gog/pin.json apps/desktop/electron-builder.yml apps/desktop/build/afterPack.cjs justfile .gitignore
git commit -m "feat(desktop): bundle and wire the pinned gog binary"
```

---

## Before opening the PR

- [ ] `just test` — quote the `N passed / N failed` summary line in the PR body.
- [ ] `npx tsc -b` clean.
- [ ] `git diff --shortstat "origin/feat/slack-tools...HEAD"` — the altitude check. Target is +250-350 prod LOC; anything past 20 files or 600 additions means stopping and splitting rather than opening.
- [ ] The PR targets **`feat/slack-tools`**, not `main`, and its body says so.
- [ ] The PR body states the plow-side prerequisite: `DEVICE_SCOPES` must gain `gmail:access-token`, and **every existing install must re-activate** — scopes freeze at mint and the failure mode is silent.
- [ ] The PR body states the delegation honestly: a ~1h Google token now lives on the Mac, and revoking the device credential does not reach one already minted.
- [ ] Confirm `git status` shows no `docs/superpowers/` files staged.
