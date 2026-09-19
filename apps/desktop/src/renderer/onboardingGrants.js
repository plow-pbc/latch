/* Setup's Access run over the ordered grant list (pluginsModel.ts's
   grantList), with no DOM: onboarding.js owns the drawing and the bridge. */

/** What the run still has to do: the open grants, less the skipped. */
function openGrants(grants, skipped) {
  return grants.filter((g) => g.status === "open" && !skipped.has(g.id));
}

/** The serialized entry point uses this distinct value for a click it ignored;
 * `undefined` remains a failed/malformed bridge result the row must explain. */
export const ACTION_IGNORED = Symbol("action ignored");

/** One serialized requirement action, shared by the primary run and a met
 * row's repeat action. A second click while one is in flight is ignored, so
 * only its own completion clears the running row. */
export function grantAction({ act, setRunning }) {
  let pending = false;
  return async (id) => {
    if (pending) return ACTION_IGNORED;
    pending = true;
    setRunning(id);
    try {
      return await act(id);
    } finally {
      pending = false;
      setRunning(null);
    }
  };
}

/** What an action result leaves for its row to explain. The same account can
 * remain met after another-account sign-in fails, so errors are independent
 * of the row's fresh status. */
export function actionMiss(id, result, kind = null, baseline = null) {
  if (result === ACTION_IGNORED) return null;
  if (!result) return { id, error: null, ...(kind ? { kind } : {}), ...(typeof baseline === "number" ? { progress: baseline } : {}) };
  const fresh = result.grants.find((grant) => grant.id === id);
  const progress = kind === "repeat" ? baseline ?? fresh?.progress : fresh?.progress ?? baseline;
  return fresh?.status === "open" || result.error
    ? { id, error: result.error, ...(kind ? { kind } : {}), ...(typeof progress === "number" ? { progress } : {}) }
    : null;
}

/** A refresh can resolve a flow after its foreground action said it missed.
 * Keep the notice only while the fresh list still calls that row open. */
export function clearMissed(missed, grants) {
  const fresh = grants.find((grant) => grant.id === missed?.id);
  if (missed?.kind === "repeat") {
    return typeof missed.progress === "number" && typeof fresh?.progress === "number" && fresh.progress > missed.progress
      ? null
      : missed;
  }
  return missed && fresh?.status !== "open" ? null : missed;
}

/** A repeat action's answer may already contain progress that arrived while
 * the connector was timing out. Reconcile before installing its row notice;
 * an unchanged count still preserves the actionable failure. */
export function repeatMiss(id, result, baseline, grants) {
  return clearMissed(actionMiss(id, result, "repeat", baseline), grants);
}

/**
 * Each open grant's flow in list order, one at a time, reading from the fresh
 * state whether it landed. `act(id)` shows that state and answers with it plus
 * `error`; `setRunning` is told the id whose flow is running, then null.
 * Resolves with the grant that did not land ({ id, error }) — a throw is a
 * miss like any other, and so is a landing with an error the owner must read
 * (Safari's setting on, Safari not reopened) — or null once nothing is left,
 * once the owner left the step, or once a grant waits on a relaunch: until
 * then this app's children can't use it, so a later flow (Safari's write)
 * would only fail.
 */
export async function runGrants({ act, getState, stillHere }, skipped) {
  for (;;) {
    const { grants } = getState();
    const next = openGrants(grants, skipped)[0];
    if (!next || grants.some((g) => g.status === "relaunch")) return null;
    const result = await act(next.id).catch(() => null);
    if (!stillHere()) return null;
    if (result === ACTION_IGNORED) return null;
    const missed = actionMiss(next.id, result);
    if (missed) return missed;
  }
}

/**
 * Access's primary button: its label and what it does — "run" the list,
 * "relaunch", "advance", or null while a flow runs. A pending relaunch comes
 * first, as it stops the run; setup reopens on Plugins, and Access runs the
 * rest. Try again only while the miss is still open (a grant made in System
 * Settings meanwhile moves on).
 */
export function accessPrimary({ grants, skipped, running, missed }) {
  const open = openGrants(grants, skipped);
  if (running) return { label: "Setting up…", kind: null };
  if (grants.some((g) => g.status === "relaunch")) return { label: "Relaunch to finish", kind: "relaunch" };
  if (missed && open.some((g) => g.id === missed.id)) return { label: "Try again", kind: "run" };
  if (open.length) return { label: `Set up all ${open.length}`, kind: "run" };
  return { label: "Continue", kind: "advance" };
}
