/**
 * The Audit tab's live index: the log's activities, kept in memory and folded
 * one event at a time as the log records them.
 *
 * Before this, every recorded event had the main process read both audit
 * generations back off disk, regroup all of them, format a locale time for
 * every step, and ship every row with every timeline to the renderer — work
 * proportional to the whole log, on every event. With an agent active that
 * was seconds of main-thread CPU per event (the spin reports that prompted
 * this). Now the log is parsed once, an event costs the rebuild of the one
 * or two rows it lands in, and a listing is a page of rows without their
 * timelines.
 *
 * Pure: no Electron, no I/O. main.ts feeds it `AuditLog.entries()` once and
 * each `recorded` entry after that; auditIndex.test.ts pins that the fold
 * never disagrees with the batch `auditActivities`.
 */
import { JSONValue } from "@domo/protocol";
import {
  ActivityGrouper,
  activityHaystack,
  activityRow,
  AuditActivity,
  AuditActivityRow,
  buildActivity,
  DecisionKind,
  StatusKind,
} from "./viewModel.js";

/** What the renderer asks for: the first rows of the filtered listing. */
export interface AuditQuery {
  /** Rows to return, newest first. Absent = the whole listing. */
  limit?: number;
  /** Free text, matched the way `activityMatches` does (title, command,
   *  agent, goal, permission, every timeline line). */
  search?: string;
  decision?: DecisionKind | "any";
  status?: StatusKind | "any";
  /** Rows at or after this moment (epoch milliseconds). */
  cutoffMs?: number | null;
  /** What the cutoff keys on: when the row began, or — for the Capabilities
   *  tab's "Show in Audit" — when this Mac blocked it, falling back to when
   *  it began for a row that was never blocked. */
  cutoffKey?: "ts" | "blocked";
  /** The selected row. When it matches the filters but lies past `limit`
   *  (new activity above it pushed it there), the window extends through it,
   *  so a live insertion never takes a selection away. A row the filters
   *  exclude is left out — that fallback is the renderer's to make. */
  keepId?: string | null;
}

export interface AuditPage {
  rows: AuditActivityRow[];
  /** How many rows match the filters, beyond this window. */
  total: number;
  /** How many rows there are in all, filters aside — whether there is a log
   *  to clear, and whether an empty listing is the filters' doing. */
  size: number;
}

interface Built {
  activity: AuditActivity;
  haystack: string;
  tsMs: number;
  blockedMs: number;
}

export class AuditIndex {
  private grouper = new ActivityGrouper();
  private built = new Map<string, Built>();
  /** Newest first; rebuilt lazily after an add. */
  private listing: Built[] | null = null;
  /** Every event, in the order the log wrote it — the log as read, for the
   *  readers that fold it themselves (the Capabilities tab). */
  private all: JSONValue[] = [];

  /** Start over from a whole log (first load, a rotation, a clear). */
  reset(events: readonly JSONValue[]): void {
    this.grouper = new ActivityGrouper();
    this.built = new Map();
    this.listing = null;
    this.all = [...events];
    const touched = new Set<string>();
    for (const e of events) for (const id of this.grouper.add(e)) touched.add(id);
    for (const id of touched) this.rebuild(id);
  }

  /** Fold one recorded event in; returns the ids of the rows it changed. */
  add(e: JSONValue): string[] {
    this.all.push(e);
    const touched = this.grouper.add(e);
    for (const id of touched) this.rebuild(id);
    if (touched.length > 0) this.listing = null;
    return touched;
  }

  /** How many activities the index holds. */
  get size(): number {
    return this.built.size;
  }

  /** The log as read, oldest first — what `AuditLog.entries()` would return,
   *  without the read. */
  events(): readonly JSONValue[] {
    return this.all;
  }

  /** One activity, timeline and all — for the detail pane. */
  get(id: string): AuditActivity | null {
    return this.built.get(id)?.activity ?? null;
  }

  /** Every activity, newest first — the batch shape, for tests and tools. */
  activities(): AuditActivity[] {
    return this.newestFirst().map((b) => b.activity);
  }

  /** The first rows of the filtered listing, without timelines. */
  page(query: AuditQuery = {}): AuditPage {
    const q = (query.search ?? "").trim().toLowerCase();
    const decision = query.decision ?? "any";
    const status = query.status ?? "any";
    const cutoff = query.cutoffMs ?? null;
    const onBlock = query.cutoffKey === "blocked";
    const matching = this.newestFirst().filter((b) => {
      const a = b.activity;
      if (decision !== "any" && a.decisionKind !== decision) return false;
      if (status !== "any" && a.statusKind !== status) return false;
      if (cutoff !== null) {
        const at = onBlock && a.blockedAt !== null ? b.blockedMs : b.tsMs;
        if (!(at >= cutoff)) return false;
      }
      if (q && !b.haystack.includes(q)) return false;
      return true;
    });
    let end = query.limit === undefined ? matching.length : Math.max(0, query.limit);
    if (query.keepId) {
      const kept = matching.findIndex((b) => b.activity.id === query.keepId);
      if (kept >= end) end = kept + 1;
    }
    return {
      rows: matching.slice(0, end).map((b) => activityRow(b.activity)),
      total: matching.length,
      size: this.built.size,
    };
  }

  private rebuild(id: string): void {
    const activity = buildActivity(id, this.grouper.eventsOf(id));
    this.built.set(id, {
      activity,
      haystack: activityHaystack(activity),
      tsMs: new Date(activity.ts).getTime(),
      blockedMs: activity.blockedAt === null ? NaN : new Date(activity.blockedAt).getTime(),
    });
  }

  private newestFirst(): Built[] {
    if (this.listing === null) {
      const out: Built[] = [];
      for (let i = this.grouper.order.length - 1; i >= 0; i -= 1) {
        const b = this.built.get(this.grouper.order[i]!);
        if (b !== undefined) out.push(b);
      }
      this.listing = out;
    }
    return this.listing;
  }
}
