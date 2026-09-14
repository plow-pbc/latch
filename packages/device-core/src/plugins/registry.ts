/**
 * What `DeviceAgent` and `mcp-server` ask: is this argv a plugin's, may it
 * run, and what env does it get. A thin lookup-and-refuse layer over what
 * already exists — `install.ts`'s on-disk shape, `argvRules.ts`'s allowlist,
 * `env.ts`'s substitution, and the skill frontmatter parser in `skills.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter, type Skill } from "../skills.js";
import { classifyArgv } from "./argvRules.js";
import { resolveEnv, type EnvContext } from "./env.js";
import { listInstalled, pluginDirs, type Installed } from "./install.js";
import type { PluginManifest } from "./manifest.js";

export interface LoadedPlugin {
  manifest: PluginManifest;
  installed: Installed;
  dirs: ReturnType<typeof pluginDirs>;
  skill: Skill;
  healthy: () => boolean;
}

export class PluginRegistry {
  private plugins = new Map<string, LoadedPlugin>();
  private issues: { name: string; problem: string }[] = [];

  constructor(private readonly pluginsRoot: string) {}

  /**
   * Reads every installed plugin. A malformed one — including a `command`
   * a plugin loaded earlier this same call already claims — is skipped and
   * reported via `problems()`, never thrown; one broken plugin can't stop
   * the rest. A one-shot bootstrap: calling it again resets every plugin's
   * `healthy()` to the daemon-absent/just-loaded default, so a caller that
   * reloads after install/remove must re-apply `setHealth` for daemons it
   * already knows are up.
   */
  load(): LoadedPlugin[] {
    this.plugins = new Map();
    this.issues = [];
    for (const { installed, manifest } of listInstalled(this.pluginsRoot)) {
      try {
        const collision = [...this.plugins.values()].find((p) => p.manifest.command === manifest.command);
        if (collision) throw new Error(`command ${manifest.command} is already claimed by ${collision.manifest.name}`);
        const dirs = pluginDirs(this.pluginsRoot, manifest.name);
        const raw = fs.readFileSync(path.join(dirs.repo, manifest.skill), "utf8");
        const skill = parseFrontmatter(raw);
        if (!skill) throw new Error("skill has no frontmatter");
        // A plugin with no daemon is always healthy; one with a daemon starts
        // unhealthy until a supervisor (Task 9) calls `setHealth`.
        const healthy = manifest.daemon === null ? () => true : () => false;
        this.plugins.set(manifest.name, { manifest, installed, dirs, skill, healthy });
      } catch (e) {
        this.issues.push({ name: manifest.name, problem: e instanceof Error ? e.message : "failed to load" });
      }
    }
    return [...this.plugins.values()];
  }

  all(): readonly LoadedPlugin[] {
    return [...this.plugins.values()];
  }

  problems(): readonly { name: string; problem: string }[] {
    return this.issues;
  }

  /** Exact argv[0] === command; a path never matches (same rule as `vendoredProvider`). */
  find(argv: readonly string[]): LoadedPlugin | null {
    if (argv.length === 0) return null;
    for (const plugin of this.plugins.values()) {
      if (plugin.manifest.command === argv[0]) return plugin;
    }
    return null;
  }

  /** The refusal, before any intent exists — daemon health first, then the argv allowlist. */
  refuse(argv: readonly string[]): string | null {
    const plugin = this.find(argv);
    if (!plugin) return null;
    if (!plugin.healthy()) return `${plugin.manifest.command} is not running`;
    const verdict = classifyArgv(plugin.manifest, argv);
    return verdict.kind === "refused" ? verdict.reason : null;
  }

  /** Extra PATH/read dirs for the Executor: every plugin's bin/ and runtime/. */
  vendorDirs(): string[] {
    return this.all().flatMap((p) => [p.dirs.bin, p.dirs.runtime]);
  }

  async env(plugin: LoadedPlugin, mint: EnvContext["mint"], plowApiBase: string): Promise<Record<string, string>> {
    const ctx: EnvContext = {
      pluginHome: plugin.dirs.home,
      port: plugin.installed.port,
      plowApiBase,
      secret: (name) => fs.readFileSync(path.join(plugin.dirs.secrets, name), "utf8"),
      mint,
    };
    return resolveEnv(plugin.manifest, ctx);
  }

  /** Task 9 plugs the supervisor in: it reports daemon health by name. */
  setHealth(name: string, healthy: () => boolean): void {
    const plugin = this.plugins.get(name);
    if (plugin) plugin.healthy = healthy;
  }
}
