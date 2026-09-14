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

function fail(message: string): never {
  throw new PluginError(message);
}
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function parseManifest(raw: string): PluginManifest {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    fail("manifest is not valid JSON");
  }
  const m = obj(json);

  const name = String(m.name ?? "");
  if (!SLUG.test(name)) fail("manifest name must be lowercase letters, digits and dashes");
  const command = String(m.command ?? "");
  if (!SLUG.test(command)) fail("manifest command must be lowercase letters, digits and dashes");
  const version = String(m.version ?? "");
  if (!version) fail("manifest needs a version");

  const runtime = obj(m.runtime);
  const binaries = (Array.isArray(runtime.binaries) ? runtime.binaries : []).map((b: unknown) => {
    const bin = obj(b);
    const bname = String(bin.name ?? "");
    if (!SLUG.test(bname)) fail("binary name must be lowercase letters, digits and dashes");
    const url = obj(bin.url);
    const sha256 = obj(bin.sha256);
    for (const arch of ARCHES) {
      if (typeof url[arch] !== "string") fail(`binary ${bname} needs a url for arm64 and x64`);
      if (typeof sha256[arch] !== "string" || !SHA.test(sha256[arch] as string)) {
        fail(`binary ${bname} needs a sha256 for arm64 and x64`);
      }
    }
    return {
      name: bname,
      version: String(bin.version ?? ""),
      url: { arm64: url.arm64 as string, x64: url.x64 as string },
      sha256: { arm64: sha256.arm64 as string, x64: sha256.x64 as string },
      ...(typeof bin.executable === "string" ? { executable: bin.executable } : {}),
    };
  });
  const sources = (Array.isArray(runtime.sources) ? runtime.sources : []).map((s: unknown) => {
    const src = obj(s);
    const sname = String(src.name ?? "");
    if (!SLUG.test(sname)) fail("source name must be lowercase letters, digits and dashes");
    if (typeof src.git !== "string" || !src.git) fail(`source ${sname} needs a git url`);
    if (typeof src.commit !== "string" || !/^[0-9a-f]{40}$/.test(src.commit)) {
      fail(`source ${sname} needs a 40-character commit`);
    }
    if (src.install !== undefined && !isStrings(src.install)) fail(`source ${sname} install must be an argv array`);
    return { name: sname, git: src.git, commit: src.commit, ...(src.install ? { install: src.install as string[] } : {}) };
  });

  const exec = obj(m.exec);
  if (typeof exec.cwd !== "string" || !isStrings(exec.argv) || exec.argv.length === 0) {
    fail("manifest needs exec.cwd and exec.argv");
  }

  let daemon: PluginManifest["daemon"] = null;
  if (m.daemon !== undefined && m.daemon !== null) {
    const d = obj(m.daemon);
    if (!isStrings(d.argv) || typeof d.health !== "string" || !d.health.startsWith("/")) {
      fail("daemon needs argv and health");
    }
    daemon = { argv: d.argv, health: d.health };
  }

  const env: Record<string, EnvSource> = {};
  for (const [key, value] of Object.entries(obj(m.env))) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail("env names must be UPPER_SNAKE_CASE");
    const v = obj(value);
    const kinds = (["fixed", "secret", "mint"] as const).filter((k) => typeof v[k] === "string");
    if (kinds.length !== 1) fail(`env value ${key} must be one of fixed, secret or mint`);
    env[key] = { [kinds[0]]: v[kinds[0]] } as EnvSource;
  }

  const argv = obj(m.argv);
  const read = Array.isArray(argv.read) ? (argv.read as unknown[]) : [];
  const write = Array.isArray(argv.write) ? (argv.write as unknown[]) : [];
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
  if (hooks.postinstall !== undefined && typeof hooks.postinstall !== "string") fail("hooks.postinstall must be a path");
  if (typeof m.skill !== "string" || !m.skill) fail("manifest needs a skill path");

  return {
    name,
    version,
    command,
    runtime: { binaries, sources },
    exec: { cwd: exec.cwd, argv: exec.argv },
    daemon,
    env,
    argv: { read: read as string[][], write: write as string[][] },
    hooks: hooks.postinstall ? { postinstall: hooks.postinstall as string } : {},
    skill: m.skill,
  };
}
