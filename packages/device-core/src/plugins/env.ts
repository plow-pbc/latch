import { PluginError, type PluginManifest } from "./manifest.js";

export interface EnvContext {
  pluginHome: string;
  port: number | null;
  plowApiBase: string;
  secret: (name: string) => Promise<string>; // throws PluginError if unknown
  mint: ((scope: string) => Promise<string>) | null; // null → a `mint` value refuses
}

export function substitute(value: string, ctx: Pick<EnvContext, "pluginHome" | "port" | "plowApiBase">): string {
  return value.replace(/\$\{(plugin_home|port|plow_api_base)\}/g, (_, key: string) => {
    if (key === "plugin_home") return ctx.pluginHome;
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
    else if ("secret" in source) out[key] = await ctx.secret(source.secret);
    else {
      if (ctx.mint === null) throw new PluginError("this Mac is not paired with Plow");
      out[key] = await ctx.mint(source.mint);
    }
  }
  return out;
}
