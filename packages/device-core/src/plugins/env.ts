import type { PluginManifest } from "./manifest.js";

export interface EnvContext {
  pluginHome: string;
  /** The owner's real home — `DeviceAgent.ownerHome`, not a test's throwaway
   *  `home`. Same reasoning as every other `${owner_home}`-shaped need in
   *  this repo: a launched app's `~/Plow` is the owner's, not the instance's. */
  ownerHome: string;
}

/** Values are computed here and handed to a child's env; nothing here logs. */
export function resolveEnv(manifest: PluginManifest, ctx: EnvContext): Record<string, string> {
  return Object.fromEntries(
    Object.entries(manifest.env).map(([key, source]) => [
      key,
      source.fixed.replace(/\$\{(plugin_home|owner_home)\}/g, (_, k: string) =>
        k === "plugin_home" ? ctx.pluginHome : ctx.ownerHome,
      ),
    ]),
  );
}
