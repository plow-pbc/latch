/* Setup's Access run over the ordered grant list (pluginsModel.ts's
   grantList), with no DOM: onboarding.js owns the drawing and the bridge. */

/** What the run still has to do: the open grants, less the skipped. */
function openGrants(grants, skipped) {
  return grants.filter((g) => g.status === "open" && !skipped.has(g.id));
}

/** What an action result leaves for its row to explain. */
export function actionMiss(id, result) {
  if (!result) return { id, error: null };
  const fresh = result.grants.find((grant) => grant.id === id);
  return fresh?.status === "open" || result.error
    ? { id, error: result.error }
    : null;
}

/** A refresh can resolve a flow after its foreground action said it missed.
 * Keep the notice only while the fresh list still calls that row open. */
export function clearMissed(missed, grants) {
  const fresh = grants.find((grant) => grant.id === missed?.id);
  return missed && fresh?.status !== "open" ? null : missed;
}

/**
 * Each open grant's flow in list order, one at a time, reading from the fresh
 * state whether it landed. `act(id)` shows that state and answers with it plus
 * `error`.
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
    const missed = actionMiss(next.id, result);
    if (missed) return missed;
  }
}

/**
 * Access's primary button: its label and what it does — "run" the list,
 * "relaunch", "advance", or null while a flow runs. A pending relaunch comes
 * first, as it stops the run; the checkpoint reopens setup on Access, where
 * the fresh inventory runs the rest. Try again only while the miss is still
 * open (a grant made in System Settings meanwhile moves on).
 */
export function accessPrimary({ grants, skipped, running, missed }) {
  const open = openGrants(grants, skipped);
  if (running) return { label: "Setting up…", kind: null };
  if (grants.some((g) => g.status === "relaunch")) return { label: "Relaunch to finish", kind: "relaunch" };
  if (missed && open.some((g) => g.id === missed.id)) return { label: "Try again", kind: "run" };
  if (open.length) return { label: `Set up all ${open.length}`, kind: "run" };
  return { label: "Continue", kind: "advance" };
}
