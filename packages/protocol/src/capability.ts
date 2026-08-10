/**
 * Capability, RuleKey, PathUtil — twin of DomoProtocol/Capability.swift.
 */
import fs from "node:fs";
import os from "node:os";
import { canonicalBytes, canonicalJSON, JSONValue } from "./json.js";
import { Hashing } from "./identity.js";

export type CapabilityKind = "fs.read" | "fs.write" | "process.exec" | "network" | "tool";

export interface Capability {
  kind: CapabilityKind;
  paths?: string[]; // fs.read / fs.write
  argv?: string[]; // process.exec (argv[0] is the executable)
  cwd?: string; // process.exec
  allowed?: boolean; // network
  tool?: string; // tool
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
    case "tool":
      return `Tool: ${c.tool ?? "?"}`;
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
  let p = path;
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/")) p = os.homedir() + p.slice(1);
  if (!p.startsWith("/")) p = process.cwd() + "/" + p;

  // Collapse "." and ".." lexically first.
  const stack: string[] = [];
  for (const component of p.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(component);
  }

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

/** True when `path` is `root` or inside it, after canonicalization. */
export function isWithin(path: string, root: string): boolean {
  const p = canonicalize(path);
  const r = canonicalize(root);
  return p === r || p.startsWith(r.endsWith("/") ? r : r + "/");
}

export function isWithinRoots(path: string, roots: string[]): boolean {
  return roots.some((root) => isWithin(path, root));
}

export const PathUtil = { canonicalize, isWithin, isWithinRoots };
