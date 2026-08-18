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

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  skill(name: string): Skill | null {
    return this.skills.get(name) ?? null;
  }

  /** Full manifest (bodies included) sent to the broker at registration. */
  manifest(): JSONValue {
    return [...this.skills.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ name: s.name, description: s.description, body: s.body }));
  }

  /** Load owner-authored skills from $DOMO_HOME/device/skills/*.md. */
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
        if (parsed) this.register(parsed);
      } catch {
        /* skip unreadable/malformed skills */
      }
    }
  }
}

function parseFrontmatter(raw: string): Skill | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  let name = "";
  let description = "";
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(name|description):\s*(.*)$/);
    if (kv) {
      if (kv[1] === "name") name = kv[2].trim();
      else description = kv[2].trim();
    }
  }
  if (!name) return null;
  return { name, description, body: m[2].trim() };
}
