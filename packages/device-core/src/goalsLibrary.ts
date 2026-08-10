/**
 * Goals Library backing the Mac-initiated spin-up flow — twin of
 * DomoDeviceCore/GoalsLibrary.swift.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface Goal {
  id: string;
  title: string;
  text: string;
  premade: boolean;
}

export const PREMADE_GOALS: Goal[] = [
  {
    id: crypto.randomUUID().toUpperCase(),
    title: "Disk usage report",
    text: "Find the 20 largest files or folders in my home directory and write a summary report to ~/Desktop/disk-report.md.",
    premade: true,
  },
  {
    id: crypto.randomUUID().toUpperCase(),
    title: "Disk space to /tmp",
    text: "Check how much disk space I have and write it to a file. Ask for access to this Mac, run `df -h`, and save the output to /tmp/disk-space.txt.",
    premade: true,
  },
  {
    id: crypto.randomUUID().toUpperCase(),
    title: "msgvault search sam",
    text: "Run the command `msgvault search sam` and write its output to a file. Ask for access to this Mac, then run `msgvault search sam` and save the result to /tmp/msgvault-sam.txt.",
    premade: true,
  },
];

export class GoalsLibrary {
  private goals: Goal[];

  constructor(public readonly file: string) {
    let stored: Goal[] | null = null;
    try {
      stored = JSON.parse(fs.readFileSync(file, "utf8")) as Goal[];
    } catch {
      /* first run */
    }
    // Always present the current premade set while keeping user goals.
    this.goals = stored
      ? [...PREMADE_GOALS, ...stored.filter((g) => !g.premade)]
      : [...PREMADE_GOALS];
    this.persist();
  }

  all(): Goal[] {
    return [...this.goals];
  }

  add(goal: { title: string; text: string }): Goal {
    const g: Goal = {
      id: crypto.randomUUID().toUpperCase(),
      title: goal.title,
      text: goal.text,
      premade: false,
    };
    this.goals.push(g);
    this.persist();
    return g;
  }

  remove(id: string): void {
    this.goals = this.goals.filter((g) => g.id !== id);
    this.persist();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.goals, null, 2) + "\n");
  }
}
