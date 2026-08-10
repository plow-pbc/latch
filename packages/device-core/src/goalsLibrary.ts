/**
 * Goals Library backing the Mac-initiated spin-up flow (DESIGN.md §2).
 *
 * Goals are plain, user-owned entries: the defaults are seeded on first run and
 * can be deleted like any other. "Restore default goals" re-adds any that are
 * missing. (There is no "built-in" distinction — a default you deleted stays
 * deleted until you restore it.)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface Goal {
  id: string;
  title: string;
  text: string;
}

const DEFAULT_GOALS: { title: string; text: string }[] = [
  {
    title: "Disk usage report",
    text: "Find the 20 largest files or folders in my home directory and write a summary report to ~/Desktop/disk-report.md.",
  },
  {
    title: "Disk space to /tmp",
    text: "Check how much disk space I have and write it to a file. Ask for access to this Mac, run `df -h`, and save the output to /tmp/disk-space.txt.",
  },
  {
    title: "msgvault search sam",
    text: "Run the command `msgvault search sam` and write its output to a file. Ask for access to this Mac, then run `msgvault search sam` and save the result to /tmp/msgvault-sam.txt.",
  },
];

function withId(g: { title: string; text: string }): Goal {
  return { id: crypto.randomUUID().toUpperCase(), title: g.title, text: g.text };
}

export class GoalsLibrary {
  private goals: Goal[];

  constructor(public readonly file: string) {
    let stored: Goal[] | null = null;
    try {
      stored = (JSON.parse(fs.readFileSync(file, "utf8")) as Goal[]).map((g) => ({
        id: g.id ?? crypto.randomUUID().toUpperCase(),
        title: g.title,
        text: g.text,
      }));
    } catch {
      /* first run */
    }
    if (stored) {
      // Load whatever the user has — deletions persist.
      this.goals = stored;
    } else {
      // First run: seed the defaults.
      this.goals = DEFAULT_GOALS.map(withId);
      this.persist();
    }
  }

  all(): Goal[] {
    return [...this.goals];
  }

  add(goal: { title: string; text: string }): Goal {
    const g = withId(goal);
    this.goals.push(g);
    this.persist();
    return g;
  }

  remove(id: string): void {
    this.goals = this.goals.filter((g) => g.id !== id);
    this.persist();
  }

  /** Re-add any default goals not currently present (matched by title). */
  restoreDefaults(): Goal[] {
    for (const d of DEFAULT_GOALS) {
      if (!this.goals.some((g) => g.title === d.title)) this.goals.push(withId(d));
    }
    this.persist();
    return this.all();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.goals, null, 2) + "\n");
  }
}
