/**
 * The approval window's whole lifecycle, with Electron injected.
 *
 * This used to live inside `main.ts`, where the only way to check it was to
 * look at it: the window, the IPC handlers, the continuation subscription and
 * the closing rules were tangled with the app's startup. The rules are not
 * incidental — a confirmation that never goes away, or one that closes while a
 * result is still uncollected, is the difference between a user knowing where
 * their approval went and guessing — so they belong somewhere a real Electron
 * run can drive them end to end.
 *
 * Nothing here is a test seam pretending to be production: `main.ts` calls this
 * with the real `BrowserWindow` and the real `ipcMain`, and the verification
 * script drives the same function with the same two.
 */
import type { BrowserWindow as BrowserWindowType, IpcMain } from "electron";
import {
  CONFIRMATION_LINGER_MS,
  ContinuationPhase,
  continuationView,
} from "./continuationView.js";

/**
 * What the window renders: the view model built from the verified intent.
 *
 * Deliberately opaque here beyond the id. This module decides when the window
 * opens, resizes and closes; what it SHOWS is `viewModel.ts`'s business, and
 * restating its shape would be a second definition to keep in step.
 */
export interface ApprovalRequest {
  kind: "intent";
  view: { intentId: string };
}

export type ApprovalDecision = "allow_once" | "always_allow" | "deny";

/** What the adversarial reviewer had to say, when it is being consulted. */
export interface ReviewSay {
  decision: ApprovalDecision | null;
  reason: string;
}

/** Where an approval's operation stands, as the registry records it. */
export interface ContinuationSnapshot {
  state: ContinuationPhase | null;
  deadlineAt: number | null;
  deliveryUnknown: boolean;
}

/** The registry's change notification, forwarded verbatim to the renderer. */
export interface ContinuationChange {
  intentId: string;
  state: ContinuationPhase | null;
  deliveryUnknown?: boolean;
}

export interface ContinuationSource {
  snapshot(intentId: string): ContinuationSnapshot;
  /** Subscribe to recorded changes; returns the unsubscribe. */
  subscribe(listener: (change: ContinuationChange) => void): () => void;
}

export interface ApprovalWindowDeps {
  ipc: IpcMain;
  /** Builds the real window. Injected so a driver can watch what it is given. */
  createWindow(): BrowserWindowType;
  /** The approval HTML to load. */
  loadFile(win: BrowserWindowType): Promise<void>;
  continuation: ContinuationSource;
  /** Resolves to the reviewer's say, or null when it is not consulted. */
  hint?: Promise<ReviewSay | null> | null;
  now?: () => number;
  /** How long a decided-but-uncollected confirmation lingers. */
  lingerMs?: number;
  /** The compact confirmation's content size. */
  confirmationSize?: { width: number; height: number };
}

/**
 * Open one approval window and resolve with the human's decision.
 *
 * The decision resolves as soon as it is made. The WINDOW may outlive it: an
 * approval whose call has already been handed off leaves the user with
 * something to do, and this is where they are told what.
 */
export function runApprovalWindow(
  request: ApprovalRequest,
  deps: ApprovalWindowDeps,
): Promise<ApprovalDecision> {
  const {
    ipc,
    createWindow,
    loadFile,
    continuation,
    hint = null,
    now = () => Date.now(),
    lingerMs = CONFIRMATION_LINGER_MS,
    confirmationSize = { width: 460, height: 190 },
  } = deps;
  const intentId = request.view.intentId;

  return new Promise<ApprovalDecision>((resolve) => {
    const win = createWindow();
    let settled = false;
    let linger: NodeJS.Timeout | null = null;

    /**
     * The most recent recorded state, held for replay.
     *
     * The renderer subscribes only after it has built its DOM, and Electron IPC
     * has no replay: a change that landed between the window pulling its model
     * and its listener going up used to vanish, leaving the window showing a
     * countdown for a call that had already been handed off. Everything is
     * buffered here until `approval:ready`, and the latest is sent then.
     */
    let latest: ContinuationChange | null = null;
    let rendererReady = false;

    const closeWindow = () => {
      if (!win.isDestroyed()) win.close();
    };

    /**
     * Send the renderer where things stand, or hold it until it can listen.
     *
     * Also the one place that closes a finished window: the renderer computes
     * that there is nothing left to show, and something has to act on it — a
     * collected result or a failure used to leave a blank confirmation sitting
     * there until the linger timer or the user got rid of it.
     */
    const publish = (change: ContinuationChange) => {
      latest = change;
      if (!rendererReady || win.isDestroyed()) return;
      win.webContents.send("approval:continuation", change);
      const view = continuationView({
        state: change.state,
        deadlineAt: continuation.snapshot(intentId).deadlineAt,
        now: now(),
        decided: settled,
        deliveryUnknown: change.deliveryUnknown,
      });
      if (view.closed) closeWindow();
    };

    const unsubscribe = continuation.subscribe((change) => {
      if (change.intentId !== intentId) return;
      publish(change);
    });

    let markReady = () => {};
    const ready = new Promise<void>((r) => {
      markReady = r;
    });

    const finish = (decision: ApprovalDecision) => {
      if (settled) return;
      settled = true;
      ipc.removeHandler("approval:get");
      ipc.removeHandler("approval:ready");
      resolve(decision);
      // An inline approval closes on the decision, as it always has. One whose
      // call is already gone — or whose handoff could not be confirmed — does
      // not: the user's next move is with their agent, and this is where they
      // are told so. It stays until the agent collects, until they dismiss it,
      // or for the linger.
      const snapshot = continuation.snapshot(intentId);
      const view = continuationView({
        state: snapshot.state,
        deadlineAt: snapshot.deadlineAt,
        now: now(),
        decided: true,
        deliveryUnknown: snapshot.deliveryUnknown,
      });
      if (!view.confirmation) {
        closeWindow();
        return;
      }
      // §4's "compact confirmation": the question is answered, so the window
      // shrinks to the size of what is left to say instead of leaving a card's
      // worth of empty space under two lines of text.
      win.setContentSize(confirmationSize.width, confirmationSize.height);
      win.webContents.send("approval:decided", { intentId });
      linger = setTimeout(closeWindow, lingerMs);
      linger.unref?.();
    };

    // The renderer pulls its model (never pushed with executable content).
    // `suggesting` tells it whether an adversarial review is in flight, so it
    // can show an indeterminate "reviewing…" indicator until the hint lands.
    ipc.handleOnce("approval:get", async () => ({
      ...request,
      suggesting: !!hint,
      continuation: continuation.snapshot(intentId),
    }));
    // The renderer calls this once its listeners are installed. `handle`, not
    // `handleOnce`: a second call must be a harmless no-op rather than a
    // rejected invoke in the renderer. Both exits below remove it.
    ipc.handle("approval:ready", async () => {
      rendererReady = true;
      markReady();
      // Anything recorded while it was building its DOM, delivered now.
      if (latest) publish(latest);
    });

    const onDecision = (_e: unknown, id: string, decision: ApprovalDecision) => {
      if (id !== intentId) return;
      ipc.removeListener("approval:decide", onDecision);
      finish(decision);
    };
    ipc.on("approval:decide", onDecision);

    // The confirmation's own dismiss. Only ever closes a window whose decision
    // is already in — a dismiss before that would be a silent deny.
    const onDismiss = (_e: unknown, id: string) => {
      if (id !== intentId || !settled) return;
      closeWindow();
    };
    ipc.on("approval:dismiss", onDismiss);

    // When the adversarial agent responds, tell the window which button to
    // highlight (or that there's no hint) so it can clear the "reviewing…"
    // indicator. Display-only, both fields: the enforceable bound the window
    // shows is the capability set in the view model, never this.
    if (hint) {
      void Promise.all([hint.catch(() => null), ready]).then(([said]) => {
        if (settled || win.isDestroyed()) return;
        win.webContents.send("approval:suggestion", {
          id: intentId,
          decision: said?.decision ?? null,
          reason: said?.reason ?? "",
        });
      });
    }

    // Closing the window without a choice is a denial (fail safe).
    win.on("closed", () => {
      ipc.removeHandler("approval:ready");
      ipc.removeListener("approval:decide", onDecision);
      ipc.removeListener("approval:dismiss", onDismiss);
      unsubscribe();
      if (linger) clearTimeout(linger);
      if (!settled) {
        settled = true;
        resolve("deny");
      }
    });

    void loadFile(win);
  });
}
