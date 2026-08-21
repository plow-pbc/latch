/**
 * Shared by the copy suites; deliberately NOT a `.test.ts`.
 *
 * This lived in toolCopy.test.ts and was imported from waitingForApproval —
 * which made Vitest execute toolCopy's suites twice: once on its own, once
 * during the other file's collection, installing its cleanup hook in a second
 * file's context. A helper is not a test entrypoint. vitest.config.ts collects
 * `test/**\/*.test.ts`, so this file is a module and nothing more.
 */
import { TOOLS } from "@domo/mcp-server";

/**
 * Bare (unprefixed) tool names in text an agent reads.
 *
 * The prefixing pass renamed `browser` and `vault` by hand-enumerated exact
 * contexts, because a blanket replace would have hit the capability kind, the
 * Vault tab and browserDir — and five were missed in one file while a
 * first-match-only test stayed green. So the rule lives here once, and every
 * agent-facing string is swept through it.
 *
 * Underscored names are unambiguous: `get_result` is never English. `browser`
 * and `vault` are ordinary words that belong in prose ("open a browser on the
 * user's own Mac"), so only call-shaped or quoted uses count as a tool
 * reference.
 */
const AMBIGUOUS = new Set(["browser", "vault"]);

export function bareToolNames(text: string): string[] {
  const hits = new Set<string>();
  for (const tool of TOOLS) {
    const bare = tool.name.replace(/^plow_/, "");
    const re = AMBIGUOUS.has(bare)
      ? new RegExp(`(?<!plow_)\\b${bare}\\s*\\{|\`${bare}\`|'${bare}'`)
      : new RegExp(`(?<![\\w.])(?<!plow_)${bare}\\b`);
    if (re.test(text)) hits.add(bare);
  }
  return [...hits].sort();
}
