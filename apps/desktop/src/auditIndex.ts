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
import { JSONValue, jv } from "@domo/protocol";
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

/** What the renderer asks for: a window of the filtered listing. */
export interface AuditQuery {
  /** Rows to skip and to return, newest first. Absent = the whole listing. */
  offset?: number;
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
  /** The newest matching row, so a selection pinned to the top can follow it. */
  topId: string | null;
}

interface Built {
  activity: AuditActivity;
  haystack: string;
  tsMs: number;
  blockedMs: number;
}

const HOST_PERMISSION_PREFIX = "host_permission_";

export class AuditIndex {
  private grouper = new ActivityGrouper();
  private built = new Map<string, Built>();
  /** Newest first; rebuilt lazily after an add. */
  private listing: Built[] | null = null;
  /** The `host_permission_*` lines, in the order the log wrote them. */
  private hostEvents: JSONValue[] = [];
  /** The `intent_received` behind each block, by intentId — what the
   *  Capabilities tab names beside a blocked request. */
  private blockedIntents = new Map<string, JSONValue>();
  private wantedIntents = new Set<string>();

  /** Start over from a whole log (first load, a rotation, a clear). */
  reset(events: readonly JSONValue[]): void {
    this.grouper = new ActivityGrouper();
    this.built = new Map();
    this.listing = null;
    this.hostEvents = [];
    this.blockedIntents = new Map();
    this.wantedIntents = new Set();
    const touched = new Set<string>();
    for (const e of events) {
      this.track(e);
      for (const id of this.grouper.add(e)) touched.add(id);
    }
    for (const id of touched) this.rebuild(id);
  }

  /** Fold one recorded event in; returns the ids of the rows it changed. */
  add(e: JSONValue): string[] {
    this.track(e);
    const touched = this.grouper.add(e);
    for (const id of touched) this.rebuild(id);
    if (touched.length > 0) this.listing = null;
    return touched;
  }

  /** How many activities the index holds. */
  get size(): number {
    return this.built.size;
  }

  /** One activity, timeline and all — for the detail pane. */
  get(id: string): AuditActivity | null {
    return this.built.get(id)?.activity ?? null;
  }

  /** Every activity, newest first — the batch shape, for tests and tools. */
  activities(): AuditActivity[] {
    return this.newestFirst().map((b) => b.activity);
  }

  /** A window of the filtered listing, rows without timelines. */
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
    const offset = Math.max(0, query.offset ?? 0);
    let end = query.limit === undefined ? matching.length : offset + Math.max(0, query.limit);
    if (query.keepId) {
      const kept = matching.findIndex((b) => b.activity.id === query.keepId);
      if (kept >= end) end = kept + 1;
    }
    return {
      rows: matching.slice(offset, end).map((b) => activityRow(b.activity)),
      total: matching.length,
      size: this.built.size,
      topId: matching[0]?.activity.id ?? null,
    };
  }

  /**
   * The subset of the log the Capabilities tab reads (capabilitiesModel.ts):
   * every `host_permission_*` line, in order, and the `intent_received` each
   * block points at. Folding this subset gives the same tab as folding the
   * whole log — its readers key on `permission` and on the block's intentId,
   * and nothing else in the log carries either — without a scan of every
   * event on every refresh.
   */
  permissionEvents(): JSONValue[] {
    return [...this.blockedIntents.values(), ...this.hostEvents];
  }

  private track(e: JSONValue): void {
    const ev = jv(e);
    const event = ev.get("event").str ?? "";
    const intentId = ev.get("intentId").str;
    if (event.startsWith(HOST_PERMISSION_PREFIX)) {
      this.hostEvents.push(e);
      if (event === "host_permission_blocked" && intentId !== null && !this.blockedIntents.has(intentId)) {
        const request = this.grouper
          .eventsOf(`intent:${intentId}`)
          .find((x) => jv(x).get("event").str === "intent_received");
        if (request !== undefined) this.blockedIntents.set(intentId, request);
        else this.wantedIntents.add(intentId);
      }
    } else if (event === "intent_received" && intentId !== null && this.wantedIntents.has(intentId)) {
      this.blockedIntents.set(intentId, e);
      this.wantedIntents.delete(intentId);
    }
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
