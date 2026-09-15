/**
 * `latch-plugin.json`, parsed and refused.
 *
 * Every refusal is a fixed sentence naming a FIELD, never quoting a value:
 * the message reaches the Settings card and the audit log, and a manifest is
 * third-party text. The one exception is the argv-overlap sentence below,
 * which quotes a prefix from the manifest itself — acceptable there because
 * that sentence only ever reaches the installer's caller (the owner) at
 * install time, never the audit log.
 */
export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginError";
  }
}

export type EnvSource = { fixed: string } | { secret: string } | { mint: string };

export interface PluginManifest {
  name: string; // ^[a-z][a-z0-9-]{0,31}$
  version: string;
  command: string; // same charset as name; argv[0] agents type
  runtime: {
    binaries: {
      name: string;
      version: string;
      url: Record<"arm64" | "x64", string>;
      sha256: Record<"arm64" | "x64", string>;
      executable?: string;
    }[];
    sources: { name: string; git: string; commit: string; install?: string[] }[];
  };
  exec: { cwd: string; argv: string[] }; // cwd is a runtime/ entry ("gbrain", "plugin"); argv[0] resolves in runtime/bin first
  daemon: { argv: string[]; health: string } | null;
  env: Record<string, EnvSource>;
  argv: { read: string[][]; write: string[][] };
  hooks: { postinstall?: string };
  skill: string; // path in repo/
}

const SLUG = /^[a-z][a-z0-9-]{0,31}$/;
const SHA = /^[0-9a-f]{64}$/;
const ARCHES = ["arm64", "x64"] as const;
/**
 * A path INSIDE the plugin's own tree: relative, no `..`, no leading `/`.
 * Every path-shaped field (exec.cwd, skill, hooks, a binary's executable) is
 * joined under `$DOMO_HOME/plugins/<name>/` by the installer, so a traversal
 * here would be a write or an exec outside the plugin's directory.
 */
const INSIDE = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\0]+$/;

function fail(message: string): never {
  throw new PluginError(message);
}
const isInside = (v: unknown): v is string => typeof v === "string" && INSIDE.test(v);
/** One name per binary / source: a duplicate would make `runtime/<name>` ambiguous. */
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
  const command = typedString(m.command, "manifest command") ?? "";
  if (!SLUG.test(command)) fail("manifest command must be lowercase letters, digits and dashes");
  const version = typedString(m.version, "manifest version") ?? "";
  if (!version) fail("manifest needs a version");

  const runtime = typedObj(m.runtime, "runtime");
  const binaries = typedArray(runtime.binaries, "runtime.binaries").map((b: unknown) => {
    const bin = obj(b);
    const bname = typedString(bin.name, "binary name") ?? "";
    if (!SLUG.test(bname)) fail("binary name must be lowercase letters, digits and dashes");
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
      version: typedString(bin.version, `binary ${bname} version`) ?? "",
      url: { arm64: url.arm64 as string, x64: url.x64 as string },
      sha256: { arm64: sha256.arm64 as string, x64: sha256.x64 as string },
      ...(bin.executable === undefined ? {} : { executable: insideOrFail(bin.executable, `binary ${bname} executable`) }),
    };
  });
  unique(binaries.map((b) => b.name), "binary");
  const sources = typedArray(runtime.sources, "runtime.sources").map((s: unknown) => {
    const src = obj(s);
    const sname = typedString(src.name, "source name") ?? "";
    if (!SLUG.test(sname)) fail("source name must be lowercase letters, digits and dashes");
    // A leading dash would read as a git option when cloned; the installer
    // also passes `--`, this is the layer under it.
    if (typeof src.git !== "string" || !src.git || src.git.startsWith("-")) fail(`source ${sname} needs a git url`);
    if (typeof src.commit !== "string" || !/^[0-9a-f]{40}$/.test(src.commit)) {
      fail(`source ${sname} needs a 40-character commit`);
    }
    if (src.install !== undefined && !isStrings(src.install)) fail(`source ${sname} install must be an argv array`);
    return { name: sname, git: src.git, commit: src.commit, ...(src.install ? { install: src.install as string[] } : {}) };
  });
  unique(sources.map((s) => s.name), "source");

  const exec = obj(m.exec);
  if (typeof exec.cwd !== "string" || !isStrings(exec.argv) || exec.argv.length === 0) {
    fail("manifest needs exec.cwd and exec.argv");
  }
  // cwd names a runtime/ entry the installer creates: a source, or `plugin`
  // (the repo itself). Anything else is a directory outside the staged tree.
  if (exec.cwd !== "plugin" && !sources.some((s) => s.name === exec.cwd)) fail("exec.cwd must be plugin or a source name");

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
    const v = obj(value);
    const kinds = (["fixed", "secret", "mint"] as const).filter((k) => typeof v[k] === "string");
    if (kinds.length !== 1) fail(`env value ${key} must be one of fixed, secret or mint`);
    env[key] = { [kinds[0]]: v[kinds[0]] } as EnvSource;
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

  const hooks = obj(m.hooks);
  const postinstall = hooks.postinstall === undefined ? null : insideOrFail(hooks.postinstall, "hooks.postinstall");
  const skill = insideOrFail(m.skill, "skill");

  return {
    name,
    version,
    command,
    runtime: { binaries, sources },
    exec: { cwd: exec.cwd, argv: exec.argv },
    daemon,
    env,
    argv: { read: read as string[][], write: write as string[][] },
    hooks: postinstall === null ? {} : { postinstall },
    skill,
  };
}

function insideOrFail(v: unknown, what: string): string {
  if (!isInside(v)) fail(`${what} must be a path inside the plugin`);
  return v;
}
