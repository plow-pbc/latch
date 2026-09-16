/**
 * Device-published skills: owner-curated how-to guides for this Mac's tools,
 * surfaced to agents via plow_list_skills + plow_read_skill. Skills are
 * documentation, not capability — reading one requires no intent.
 *
 * Sources: built-ins registered in code, plus $DOMO_HOME/device/skills/*.md
 * with YAML-ish frontmatter (name:, description:).
 */
import fs from "node:fs";
import path from "node:path";
import { JSONValue } from "@domo/protocol";

export interface Skill {
  name: string;
  description: string;
  body: string;
}

/**
 * Render a recipe stored unindented (so tests can run it verbatim) as the
 * four-space code block a skill body wants. One formatting contract, one site
 * — the whatsapp/imessage/contacts skills all format their hoisted SQL with
 * this.
 */
export function indentSkillCodeBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? "    " + line : line))
    .join("\n");
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  /**
   * Names the owner wrote themselves. Nothing a built-in or a plugin sync
   * does may overwrite or withdraw one: the owner putting a file in their own
   * DOMO_HOME is a deliberate act, and this Mac's defaults are not an opinion
   * about it. The rule lives here rather than in registration ORDER, because
   * `syncPluginSkills` runs again on every off-switch toggle — load order
   * only holds until the second call.
   */
  private owned = new Set<string>();

  register(skill: Skill): void {
    if (this.owned.has(skill.name)) return;
    this.skills.set(skill.name, skill);
  }

  /** Withdraw a skill — the owner turned off the plugin it documents, and a
   *  skill for a CLI the exec path now refuses teaches an agent nothing but
   *  a dead end. An owner's own file under the same name stays. */
  unregister(name: string): void {
    if (this.owned.has(name)) return;
    this.skills.delete(name);
  }

  skill(name: string): Skill | null {
    return this.skills.get(name) ?? null;
  }

  /**
   * What `plow_list_skills` advertises: names and descriptions, sorted.
   *
   * Bodies are deliberately NOT here. They used to be, because the whole
   * manifest was shipped to the broker at registration; there is no broker and
   * the only consumer is the tool, which stripped them straight back off. A
   * body is fetched one at a time by `plow_read_skill`, which is what keeps a
   * long operator manual off every tools/list.
   */
  manifest(): { name: string; description: string }[] {
    return [...this.skills.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, description }) => ({ name, description }));
  }

  /**
   * Load owner-authored skills from $DOMO_HOME/device/skills/*.md.
   *
   * Sampled once, at construction, so `owned` has the same lifetime as the
   * skills it names: a file deleted while the app runs does not free its name
   * until restart, exactly as its content would not change.
   */
  loadDir(dir: string): void {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      return;
    }
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), "utf8");
        const parsed = parseFrontmatter(raw);
        if (parsed) {
          this.owned.add(parsed.name);
          this.skills.set(parsed.name, parsed);
        }
      } catch {
        /* skip unreadable/malformed skills */
      }
    }
  }
}

/** Exported so a caller with a single known file (a plugin-declared skill
 * path) can parse it without a directory scan — `loadDir` below is for the
 * `$DOMO_HOME/device/skills/*.md` case, a different source of the same shape. */
export function parseFrontmatter(raw: string): Skill | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  let name = "";
  let description = "";
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(name|description):(.*)$/);
    if (kv) {
      if (kv[1] === "name") name = kv[2].trim();
      else description = kv[2].trim();
    }
  }
  if (!name) return null;
  return { name, description, body: m[2].trim() };
}
