/**
 * Capability, RuleKey, PathUtil — twin of DomoProtocol/Capability.swift.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import { canonicalBytes, canonicalJSON, JSONValue } from "./json.js";
import { Hashing } from "./identity.js";
import { normalizeOrigin } from "./origins.js";

export type CapabilityKind =
  | "fs.read"
  | "fs.write"
  | "process.exec"
  | "network"
  | "tool"
  | "browser"
  | "credential";

export interface Capability {
  kind: CapabilityKind;
  paths?: string[]; // fs.read / fs.write
  argv?: string[]; // process.exec (argv[0] is the executable)
  cwd?: string; // process.exec
  allowed?: boolean; // network
  tool?: string; // tool: the action, e.g. "slack.messages.list"
  /**
   * tool: WHAT the action acts on — "<account>" or "<account>/<channel>".
   *
   * The target belongs to the capability and the content does not, exactly
   * as `paths` holds an fs.write's path while the bytes ride the payload.
   * Without it a rule key covers only "may send Slack messages", so one
   * "always allow" authorises every channel in every workspace forever and
   * the approval dialog names no target to judge. With it, two channels are
   * two rules — and message text, which would make every key unique, stays
   * out of the key.
   */
  target?: string;
  /**
   * tool: the exact selector a read is scoped BY, when the target alone does
   * not bound it — today only a Slack search's query.
   *
   * A search's query is its read scope the way a path is an `fs.read`'s: the
   * workspace says where to look, the query says what may be read. With only
   * the workspace in the key, one "always allow" on a benign search authorises
   * every later query against the owner's whole Slack. Separate from `target`
   * rather than folded into it because a query is free text — it can contain
   * the delimiter a scope path uses, so concatenating them would let two
   * different requests produce one key.
   *
   * The trade this accepts: always-allow becomes per-query for search, exactly
   * as `fs.read`'s is per-path.
   */
  selector?: string;
  origins?: string[]; // browser: host patterns ("dominos.com", "*.dominos.com")
  access?: "fill"; // credential: type values into pages
  items?: string[]; // credential(fill): vault item ids
  reason?: string; // display-only justification
}

/**
 * Normalized form used for rule keys: display-only fields stripped, paths
 * canonicalized and sorted so equivalent requests hash identically.
 */
export function normalizedCapability(c: Capability): Capability {
  const out: Capability = { ...c };
  delete out.reason;
  if (out.paths) out.paths = out.paths.map((p) => canonicalize(p)).sort();
  if (out.cwd !== undefined) out.cwd = canonicalize(out.cwd);
  if (out.origins) out.origins = out.origins.map((o) => normalizeOrigin(o)).sort();
  if (out.items) out.items = [...out.items].sort();
  return out;
}

/** Human-readable one-liner for approval UIs and audit logs. */
export function capabilityDisplay(c: Capability): string {
  switch (c.kind) {
    case "fs.read":
      return `Read: ${(c.paths ?? []).join(", ")}`;
    case "fs.write":
      return `Write: ${(c.paths ?? []).join(", ")}`;
    case "process.exec": {
      const cmd = (c.argv ?? []).join(" ");
      return `Run: ${cmd}` + (c.cwd !== undefined ? ` (in ${c.cwd})` : "");
    }
    case "network":
      return c.allowed ? "Network: allowed" : "Network: denied";
    case "tool": {
      const action = (c.tool ?? "?").replace(/^slack\./, "");
      // The target is what the owner is actually authorising. A capability
      // carrying none names no scope, and must not imply one.
      const where = c.target ? `${action} in ${c.target}` : action;
      // The selector is part of what is authorised, so it is part of what the
      // approval card and the audit log say was authorised.
      return c.selector ? `Slack: ${where} for "${c.selector}"` : `Slack: ${where}`;
    }
    case "browser":
      return `Browse: ${(c.origins ?? []).join(", ")}`;
    case "credential":
      // A rule saved before the metadata capability was removed can still be
      // sitting in rules.json, and `access` no longer types that shape.
      // Nothing requests it any more, so it grants nothing — but the owner
      // reviewing stored grants must read back what they actually approved,
      // not see it relabelled as a credential-fill grant they never gave.
      if (c.access !== "fill") return "Credentials: a shape no longer requested (grants nothing)";
      return `Credentials: fill ${(c.items ?? []).join(", ")} into approved sites (typed on this Mac; the agent can see the page it types into)`;
    default:
      // rules.json is parsed and cast without validation, so a stored
      // capability can carry a kind outside the current union. Naming it is
      // worth more to someone deciding whether to revoke than `undefined`.
      return (c as Capability).kind;
  }
}

export const RuleKey = {
  /**
   * Exact-capability-match rule key (DESIGN.md §5): SHA-256 over the canonical
   * JSON of agent + device + normalized capabilities. Goal text is
   * deliberately excluded — it is unverifiable.
   */
  compute(agentId: string, deviceId: string, capabilities: Capability[]): string {
    const normalized = capabilities
      .map(normalizedCapability)
      .sort((a, b) => {
        const ea = canonicalJSON(a as unknown as JSONValue);
        const eb = canonicalJSON(b as unknown as JSONValue);
        return ea < eb ? -1 : ea > eb ? 1 : 0;
      });
    const payload = { agent: agentId, device: deviceId, caps: normalized };
    return Hashing.sha256Hex(canonicalBytes(payload as unknown as JSONValue));
  },
};

/**
 * Canonicalize to a TRUE physical path: expand ~, make absolute, collapse
 * "." / "..", and resolve symlinks via realpath() on the longest existing
 * prefix (appending any not-yet-existing remainder).
 *
 * This must return the real path the kernel sees (e.g. /private/var/…, not
 * /var/…) because seatbelt enforces against physical paths. Node's
 * fs.realpathSync is realpath(3) and preserves /private — do not swap in
 * anything that normalizes differently.
 */
export function canonicalize(path: string): string {
  const stack = lexicalComponents(path);

  // Walk from the leaf up to find the longest existing prefix, realpath it,
  // then re-append the components below it.
  const remainder: string[] = [];
  const prefix = [...stack];
  while (prefix.length > 0) {
    const candidate = "/" + prefix.join("/");
    let resolved: string | null = null;
    try {
      resolved = fs.realpathSync(candidate);
    } catch {
      resolved = null;
    }
    if (resolved !== null) {
      return [resolved, ...remainder.reverse()].join("/");
    }
    remainder.push(prefix.pop()!);
  }
  return "/" + remainder.reverse().join("/");
}

/**
 * The lexical half of canonicalization, shared by both variants so they cannot
 * drift: `~` expansion, making the path absolute, and collapsing "." / "..".
 * Returns the path components, leaf last.
 */
function lexicalComponents(path: string): string[] {
  let p = path;
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/")) p = os.homedir() + p.slice(1);
  if (!p.startsWith("/")) p = process.cwd() + "/" + p;

  const stack: string[] = [];
  for (const component of p.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(component);
  }
  return stack;
}

/**
 * `canonicalize` without blocking the event loop.
 *
 * Byte-identical to the synchronous one — `fs.promises.realpath` is the same
 * realpath(3), and the lexical half is literally the same code — and asserted
 * against the same golden vectors. It exists because resolution is filesystem
 * I/O: on a slow or unresponsive mounted volume the synchronous version blocks
 * the loop, which stops a call budget's timer from ever firing. Anything
 * running under a budget must use this one.
 */
export async function canonicalizeAsync(path: string): Promise<string> {
  const stack = lexicalComponents(path);
  const remainder: string[] = [];
  const prefix = [...stack];
  while (prefix.length > 0) {
    const candidate = "/" + prefix.join("/");
    let resolved: string | null = null;
    try {
      resolved = await fsp.realpath(candidate);
    } catch {
      resolved = null;
    }
    if (resolved !== null) {
      return [resolved, ...remainder.reverse()].join("/");
    }
    remainder.push(prefix.pop()!);
  }
  return "/" + remainder.reverse().join("/");
}

/** True when `path` is `root` or inside it, after canonicalization. */
export function isWithin(path: string, root: string): boolean {
  const p = canonicalize(path);
  const r = canonicalize(root);
  return p === r || p.startsWith(r.endsWith("/") ? r : r + "/");
}

export function isWithinRoots(path: string, roots: string[]): boolean {
  return roots.some((root) => isWithin(path, root));
}

/**
 * `isWithin` / `isWithinRoots` without blocking the event loop. Same predicate,
 * same canonical bytes — see `canonicalizeAsync`. Anything running under a call
 * budget must use these, because scope-checking resolves paths and resolution
 * is filesystem I/O.
 */
export async function isWithinAsync(path: string, root: string): Promise<boolean> {
  const p = await canonicalizeAsync(path);
  const r = await canonicalizeAsync(root);
  return p === r || p.startsWith(r.endsWith("/") ? r : r + "/");
}

export async function isWithinRootsAsync(path: string, roots: string[]): Promise<boolean> {
  const results = await Promise.all(roots.map((root) => isWithinAsync(path, root)));
  return results.some(Boolean);
}

export const PathUtil = { canonicalize, isWithin, isWithinRoots };
