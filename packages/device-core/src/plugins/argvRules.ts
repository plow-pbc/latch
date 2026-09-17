import type { PluginManifest } from "./manifest.js";

export type ArgvVerdict =
  | { kind: "read"; prefix: string[] }
  | { kind: "write" }
  | { kind: "refused"; reason: string };

const startsWith = (argv: readonly string[], prefix: readonly string[]) =>
  prefix.every((tok, i) => argv[i] === tok);

/**
 * The refusal names the ALLOWED prefixes, which are the manifest author's
 * words — never the agent's argv, which would put a stranger's text into a
 * sentence the owner reads in the audit log.
 */
export function classifyArgv(manifest: PluginManifest, argv: readonly string[]): ArgvVerdict {
  const tail = argv.slice(1);
  const read = manifest.argv.read.find((p) => startsWith(tail, p));
  if (read) return { kind: "read", prefix: read };
  if (manifest.argv.write.some((p) => startsWith(tail, p))) return { kind: "write" };
  const allowed = [...manifest.argv.read, ...manifest.argv.write].map((p) => p.join(" ")).join(", ");
  return { kind: "refused", reason: `${manifest.command} allows: ${allowed}` };
}

export function ruleArgv(manifest: PluginManifest, argv: readonly string[]): readonly string[] {
  const verdict = classifyArgv(manifest, argv);
  return verdict.kind === "read" ? [argv[0], ...verdict.prefix] : argv;
}
