import { PluginError, type PluginManifest } from "./manifest.js";

export interface EnvContext {
  pluginHome: string;
  /** The owner's real home — `DeviceAgent.ownerHome`, not a test's throwaway
   *  `home`. Same reasoning as every other `${owner_home}`-shaped need in
   *  this repo: a launched app's `~/Plow` is the owner's, not the instance's. */
  ownerHome: string;
  port: number | null;
  plowApiBase: string;
  secret: (name: string) => string; // throws PluginError if unknown
  mint: ((scope: string) => Promise<string>) | null; // null → a `mint` value refuses
}

export function substitute(
  value: string,
  ctx: Pick<EnvContext, "pluginHome" | "ownerHome" | "port" | "plowApiBase">,
): string {
  return value.replace(/\$\{(plugin_home|owner_home|port|plow_api_base)\}/g, (_, key: string) => {
    if (key === "plugin_home") return ctx.pluginHome;
    if (key === "owner_home") return ctx.ownerHome;
    if (key === "plow_api_base") return ctx.plowApiBase;
    if (ctx.port === null) throw new PluginError("${port} needs a daemon");
    return String(ctx.port);
  });
}

/** Values are computed here and handed to a child's env; nothing here logs. */
export async function resolveEnv(manifest: PluginManifest, ctx: EnvContext): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, source] of Object.entries(manifest.env)) {
    if ("fixed" in source) out[key] = substitute(source.fixed, ctx);
    else if ("secret" in source) out[key] = ctx.secret(source.secret);
    else {
      if (ctx.mint === null) throw new PluginError("this Mac is not paired with Plow");
      out[key] = await ctx.mint(source.mint);
    }
  }
  return out;
}
