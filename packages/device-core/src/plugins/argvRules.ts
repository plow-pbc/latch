import type { PluginManifest } from "./manifest.js";

export type ArgvVerdict =
  | { kind: "read"; prefix: string[] }
  | { kind: "write" }
  | { kind: "refused"; reason: string };

const startsWith = (argv: readonly string[], prefix: readonly string[]) =>
  prefix.every((tok, i) => argv[i] === tok);

/**
 * Globals that select which archive to open. They are only legal inside a
 * pinned prefix (`--app whatsapp chats`). After a matched verb they would
 * ride along as extra argv and could retarget the read. `--store` is the
 * same shape and is never a prefix, so it is refused in either position.
 */
const STORE_GLOBALS = new Set(["--app", "--store"]);

const globalsAfter = (tail: readonly string[], prefix: readonly string[]) =>
  tail.slice(prefix.length).some((tok) => STORE_GLOBALS.has(tok));

/**
 * The refusal names the ALLOWED prefixes, which are the manifest author's
 * words — never the agent's argv, which would put a stranger's text into a
 * sentence the owner reads in the audit log.
 */
export function classifyArgv(manifest: PluginManifest, argv: readonly string[]): ArgvVerdict {
  const tail = argv.slice(1);
  const allowed = [...manifest.argv.read, ...manifest.argv.write].map((p) => p.join(" ")).join(", ");
  const refused = (): ArgvVerdict => ({ kind: "refused", reason: `${manifest.command} allows: ${allowed}` });
  const read = manifest.argv.read.find((p) => startsWith(tail, p));
  if (read) return globalsAfter(tail, read) ? refused() : { kind: "read", prefix: read };
  if (manifest.argv.write.some((p) => startsWith(tail, p))) {
    const write = manifest.argv.write.find((p) => startsWith(tail, p))!;
    return globalsAfter(tail, write) ? refused() : { kind: "write" };
  }
  return refused();
}

export function ruleArgv(manifest: PluginManifest, argv: readonly string[]): readonly string[] {
  const verdict = classifyArgv(manifest, argv);
  return verdict.kind === "read" ? [argv[0], ...verdict.prefix] : argv;
}
