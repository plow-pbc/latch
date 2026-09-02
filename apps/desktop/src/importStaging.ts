/**
 * The Import sheet's staging slot — the parsed logins held in MAIN between
 * inspect and commit, so the renderer only ever sees a secret-free preview
 * and commit imports whatever main is holding.
 *
 * One slot, because the sheet is modal; but TWO clocks guard it, because two
 * different things can go stale against it:
 *
 *  - The EPOCH voids answers. An inspect captures the epoch before parsing
 *    and stages only if it still holds afterwards — a sheet that closed while
 *    the parse was in flight has already cancelled, and its answer must not
 *    quietly re-stage the plaintext the cancel existed to drop. Every cancel,
 *    commit, and credential-exchange staging bumps it.
 *
 *  - The TICKET names the staging. Every staging takes a fresh ticket, and
 *    the preview handed back carries it; the sheet quotes it on commit and on
 *    close. That is what lets main tell "this sheet dropping its own work"
 *    from "a stale sheet stomping what replaced it": a credential exchange
 *    can stage OVER an open sheet (Apple Passwords hands one over while the
 *    sheet sits on its pick step), and that sheet's close must not cancel the
 *    exchange away — nor may its in-flight commit import the exchange's
 *    logins under the row indices of a preview it no longer matches.
 *
 * A sheet closed before any preview arrived has no ticket to quote and
 * cancels with null: that drops sheet-origin staging (its own inspect may
 * have landed after it stopped listening) but never an exchange's — the
 * exchange was staged by main, not by any sheet, and outlives them all until
 * its own sheet answers for it.
 *
 * Pure state, no I/O — main.ts owns the vault calls and the IPC; this is the
 * part vitest can hold to account (importStaging.test.ts).
 */
import type { ImportedLogin, ImportPreview } from "@domo/device-core";

/** A preview plus the ticket naming the staging it describes. Ticket 0 means
 * the answer arrived too late to stage — shown to no one (the sheet that
 * asked is gone), and matching no staging if it ever were. */
export interface StagedPreview extends ImportPreview {
  ticket: number;
}

/**
 * Whether this macOS's Passwords app offers "Export … to App…" at all — the
 * menu items arrived in 26.4. This is only the OS half of the answer: whether
 * THIS install can be the app on the receiving end (packaged, extension
 * shipped, shim present) is the caller's half, checked beside the facts it
 * needs. The Import sheet's Apple guidance offers the hand-off only when
 * both halves say yes.
 */
export function passwordsAppCanHandOff(systemVersion: string): boolean {
  const [major = 0, minor = 0] = systemVersion.split(".").map((part) => Number(part) || 0);
  return major > 26 || (major === 26 && minor >= 4);
}

/** What a commit consumes: the logins main is holding and the preview the
 * sheet was shown of them — the pick step re-stages a subset of both. */
export interface StagedImport {
  logins: ImportedLogin[];
  preview: ImportPreview;
}

export class ImportStaging {
  private staged: StagedImport | null = null;
  private origin: "sheet" | "exchange" = "sheet";
  private ticket = 0;
  private seq = 0;
  private epochNow = 0;
  private exchange: StagedPreview | null = null;

  /** Captured when a request begins — for a file pick, before the dialog even
   * opens — and quoted back to stageSheet, which refuses a stale one. */
  get epoch(): number {
    return this.epochNow;
  }

  /** An inspect's answer. Stages only if `epoch` still holds; either way the
   * preview comes back stamped (ticket 0 when it did not stage). */
  stageSheet(epoch: number, logins: ImportedLogin[], preview: ImportPreview): StagedPreview {
    if (epoch !== this.epochNow) return { ...preview, ticket: 0 };
    this.staged = { logins, preview };
    this.origin = "sheet";
    this.ticket = ++this.seq;
    // An exchange this replaces is answered for: its preview must not reopen
    // a sheet over staging that is no longer its.
    this.exchange = null;
    return { ...preview, ticket: this.ticket };
  }

  /** A credential exchange staged by main itself (no sheet asked). The epoch
   * bump voids any sheet inspect still parsing — an owner-approved hand-off
   * must not be overwritten by a slower paste. */
  stageExchange(logins: ImportedLogin[], preview: ImportPreview): StagedPreview {
    this.epochNow++;
    this.staged = { logins, preview };
    this.origin = "exchange";
    this.ticket = ++this.seq;
    this.exchange = { ...preview, ticket: this.ticket };
    return this.exchange;
  }

  /** The exchange staged and not yet answered — what the vault pane asks for
   * so it can open the Import sheet on it. Secret-free, like every preview. */
  pendingExchange(): StagedPreview | null {
    return this.exchange;
  }

  /**
   * Take what is staged — for a commit, or for the vault pick, which puts a
   * subset of it straight back. A commit quoting a ticket that is
   * not the current staging's is refused BEFORE anything is cleared — the
   * newer staging is not the stale sheet's to consume or to drop — and the
   * refusal names what happened rather than importing the wrong rows.
   */
  take(ticket: number | undefined): StagedImport {
    if (typeof ticket === "number" && ticket !== this.ticket) {
      throw new Error("a newer import replaced this one; nothing was imported");
    }
    const staged = this.staged;
    this.drop();
    if (!staged) throw new Error("nothing is staged to import; choose a file or paste again");
    return staged;
  }

  /**
   * A sheet closed. `ticket` is the staging it saw (null before any preview
   * arrived). Drops the staging only if it was that sheet's to drop; the
   * epoch bump happens regardless, so an inspect the closed sheet still has
   * in flight can never stage.
   */
  cancel(ticket: number | null): void {
    this.epochNow++;
    const owns = ticket === null ? this.origin === "sheet" : ticket === this.ticket;
    if (owns) this.drop();
  }

  private drop(): void {
    this.staged = null;
    this.exchange = null;
    this.epochNow++;
  }
}
