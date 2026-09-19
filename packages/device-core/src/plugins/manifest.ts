/**
 * `latch-plugin.json`, parsed and refused.
 *
 * Every refusal is a fixed sentence naming a FIELD, never quoting a value — a
 * manifest is third-party text. The one exception is the argv-overlap sentence
 * below, which quotes a prefix from the manifest itself. Both are acceptable
 * because a PluginError reaches the owner directly — the installer's caller,
 * or launch-time stderr — never the audit log or an agent.
 */

import { AUTOMATION_APPS, QUERYABLE_PERMISSIONS } from "../hostGate/inventory.js";

/** The account connectors this Mac can connect — "Connect Google" is the only
 *  button the Plugins tab can offer, so any other id is a requirement nothing
 *  can ever meet. Refused at the boundary. */
const ACCOUNT_IDS: ReadonlySet<string> = new Set(["google"]);

/** The permissions this Mac can both check and walk an owner through. */
const PERMISSION_IDS: ReadonlySet<string> = new Set([
  "full_disk_access",
  ...QUERYABLE_PERMISSIONS,
  ...AUTOMATION_APPS.map((a) => `automation:${a.bundleId}`),
]);

export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginError";
  }
}

export type EnvSource = { fixed: string };

/** What a plugin needs before it can work: a connector the owner must
 *  connect, and a macOS permission the owner must grant. Present and empty
 *  when the manifest omits it. */
export interface PluginRequires {
  accounts: string[]; // a connector id the app can connect, e.g. "google"
  permissions: string[]; // a Settings › Permissions row key, e.g. "full_disk_access"
}

/** The accounts `requires` names that are not connected — the one readiness
 *  rule, for the device's gate and the Plugins tab alike. */
export function missingPluginAccounts(requires: PluginRequires, connected: ReadonlySet<string>): string[] {
  return requires.accounts.filter((id) => !connected.has(id));
}

export interface PluginManifest {
  name: string; // ^[a-z][a-z0-9-]{0,31}$
  title?: string; // what the owner reads on the Plugins tab; absent, the tab shows `name`
  summary?: string; // what the owner reads on the setup flow; absent, the tab shows no summary
  version: string;
  command: string; // same charset as name; argv[0] agents type
  runtime: {
    binaries: {
      name: string;
      url: Record<"arm64" | "x64", string>;
      sha256: Record<"arm64" | "x64", string>;
      executable?: string;
    }[];
  };
  exec: { argv: string[] }; // runs in the plugin's own directory; each binary is staged as runtime/<arch>/bin/<binary name>, which leads a child's PATH — argv[0] names one of those or anything else on PATH
  daemon: { argv: string[]; health: string } | null;
  env: Record<string, EnvSource>;
  argv: { read: string[][]; write: string[][] };
  hooks: { postinstall?: string };
  requires: PluginRequires;
  skill: string | null; // path in repo/, or null when a code layer publishes the skill
}

const SLUG = /^[a-z][a-z0-9-]{0,31}$/;
const SHA = /^[0-9a-f]{64}$/;
const ARCHES = ["arm64", "x64"] as const;
/**
 * Forbids a `..` path segment: joined under a directory, `..` climbs back
 * out of it, whether that's a write (INSIDE, below) or an exec (argv[0]).
 */
const NO_DOTDOT = /^(?!.*(^|\/)\.\.(\/|$))[^\0]+$/;
/**
 * NO_DOTDOT plus no leading `/`: a path INSIDE the plugin's own tree,
 * relative only. Every path-shaped field (skill, hooks, a binary's
 * executable) is joined under `$DOMO_HOME/plugins/<name>/` by the installer,
 * so a traversal here would be a write outside the plugin's directory.
 */
const INSIDE = new RegExp(`^(?!/)${NO_DOTDOT.source.slice(1)}`);

function fail(message: string): never {
  throw new PluginError(message);
}
const isInside = (v: unknown): v is string => typeof v === "string" && INSIDE.test(v);
/** One name per binary: a duplicate would make `runtime/<arch>/bin/<name>` ambiguous. */
function unique(names: string[], what: string): void {
  if (new Set(names).size !== names.length) fail(`${what} names must be unique`);
}
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/** An absent container defaults empty; a present one of the wrong type is refused, never coerced. */
function typedObj(v: unknown, what: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) fail(`${what} must be an object`);
  return v as Record<string, unknown>;
}
function typedArray(v: unknown, what: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(`${what} must be an array`);
  return v;
}
/** A present-but-wrong-type list is refused, never coerced; absent is empty. */
function strList(v: unknown, field: string): string[] {
  return typedArray(v, field).map((e: unknown) => {
    if (typeof e !== "string") fail(`${field} entries must be strings`);
    return e;
  });
}
/** Absent stays absent (caller applies its own default); a present value of the wrong type is refused, never stringified. */
function typedString(v: unknown, what: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") fail(`${what} must be a string`);
  return v;
}

export function parseManifest(raw: string): PluginManifest {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    fail("manifest is not valid JSON");
  }
  const m = obj(json);

  const name = typedString(m.name, "manifest name") ?? "";
  if (!SLUG.test(name)) fail("manifest name must be lowercase letters, digits and dashes");
  const title = typedString(m.title, "manifest title");
  if (title !== undefined && !title.trim()) fail("manifest title must not be blank");
  const summary = typedString(m.summary, "manifest summary");
  if (summary !== undefined && !summary.trim()) fail("manifest summary must not be blank");
  const command = typedString(m.command, "manifest command") ?? "";
  if (!SLUG.test(command)) fail("manifest command must be lowercase letters, digits and dashes");
  const version = typedString(m.version, "manifest version") ?? "";
  if (!version) fail("manifest needs a version");

  const runtime = typedObj(m.runtime, "runtime");
  const binaries = typedArray(runtime.binaries, "runtime.binaries").map((b: unknown) => {
    const bin = obj(b);
    const bname = typedString(bin.name, "binary name") ?? "";
    if (!SLUG.test(bname)) fail("binary name must be lowercase letters, digits and dashes");
    if (bname === "bin") fail('binary name must not be "bin" — runtime/<arch>/bin is reserved');
    const url = obj(bin.url);
    const sha256 = obj(bin.sha256);
    for (const arch of ARCHES) {
      // https only: the bytes are verified by sha, but a plaintext or file: URL
      // is still a download the owner did not intend to trust the network with.
      if (typeof url[arch] !== "string" || !url[arch].startsWith("https://")) {
        fail(`binary ${bname} needs an https url for arm64 and x64`);
      }
      if (typeof sha256[arch] !== "string" || !SHA.test(sha256[arch] as string)) {
        fail(`binary ${bname} needs a sha256 for arm64 and x64`);
      }
    }
    return {
      name: bname,
      url: { arm64: url.arm64 as string, x64: url.x64 as string },
      sha256: { arm64: sha256.arm64 as string, x64: sha256.x64 as string },
      ...(bin.executable === undefined ? {} : { executable: insideOrFail(bin.executable, `binary ${bname} executable`) }),
    };
  });
  unique(binaries.map((b) => b.name), "binary");

  const exec = obj(m.exec);
  if (!isStrings(exec.argv) || exec.argv.length === 0) fail("manifest needs exec.argv");
  // A ".." here would let a manifest name an arbitrary host file as the
  // thing to exec. An absolute argv[0] (e.g. /bin/sh) is legitimate for a
  // plugin run BY NAME: nothing joins it under bin/, so it falls through to
  // PATH or the filesystem at exec time. A plugin driven by a provider row
  // (plow-gog) is the other case — the exec path joins its argv[0] under the
  // staged bin/ — so that one must be relative and name a staged binary, or
  // the join nests an absolute path and resolves nothing.
  if (!NO_DOTDOT.test(exec.argv[0])) fail("exec.argv[0] must not contain a .. segment");

  let daemon: PluginManifest["daemon"] = null;
  if (m.daemon !== undefined && m.daemon !== null) {
    const d = typedObj(m.daemon, "daemon");
    if (!isStrings(d.argv) || d.argv.length === 0 || typeof d.health !== "string" || !d.health.startsWith("/")) {
      fail("daemon needs argv and health");
    }
    daemon = { argv: d.argv, health: d.health };
  }

  const env: Record<string, EnvSource> = {};
  for (const [key, value] of Object.entries(typedObj(m.env, "env"))) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail("env names must be UPPER_SNAKE_CASE");
    const fixed = obj(value).fixed;
    if (typeof fixed !== "string") fail(`env value ${key} needs a fixed string`);
    env[key] = { fixed };
  }

  const argv = typedObj(m.argv, "argv");
  const read = typedArray(argv.read, "argv.read");
  const write = typedArray(argv.write, "argv.write");
  const prefixes = [...read, ...write];
  if (!prefixes.every(isStrings)) fail("argv prefixes must be arrays of strings");
  const stringPrefixes = prefixes as string[][];
  if (stringPrefixes.some((p) => p.length === 0)) fail("argv prefixes must not be empty");
  // A quoted prefix here is manifest text, not audit text — see the class comment above.
  for (const a of stringPrefixes) {
    for (const b of stringPrefixes) {
      if (a !== b && a.every((tok, i) => b[i] === tok)) fail(`argv prefixes must not overlap: ${a.join(" ")}`);
    }
  }

  // Names the field, never the value: a requirement id is third-party text.
  const req = typedObj(m.requires, "requires");
  const requires: PluginRequires = {
    accounts: strList(req.accounts, "requires.accounts").map((e) => {
      if (!ACCOUNT_IDS.has(e)) fail("requires.accounts entries must name an account connector this Mac offers");
      return e;
    }),
    permissions: strList(req.permissions, "requires.permissions").map((e) => {
      if (!PERMISSION_IDS.has(e)) fail("requires.permissions entries must name a permission this Mac can check");
      return e;
    }),
  };

  const hooks = obj(m.hooks);
  const postinstall = hooks.postinstall === undefined ? null : insideOrFail(hooks.postinstall, "hooks.postinstall");
  const skill = m.skill === undefined ? null : insideOrFail(m.skill, "skill");

  return {
    name,
    ...(title === undefined ? {} : { title }),
    ...(summary === undefined ? {} : { summary }),
    version,
    command,
    runtime: { binaries },
    exec: { argv: exec.argv },
    daemon,
    env,
    argv: { read: read as string[][], write: write as string[][] },
    hooks: postinstall === null ? {} : { postinstall },
    requires,
    skill,
  };
}

function insideOrFail(v: unknown, what: string): string {
  if (!isInside(v)) fail(`${what} must be a path inside the plugin`);
  return v;
}
