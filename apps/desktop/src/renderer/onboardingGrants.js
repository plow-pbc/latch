/* Setup's Access run over the ordered grant list (pluginsModel.ts's
   grantList), with no DOM: onboarding.js owns the drawing and the bridge. */

/** What the run still has to do: the open grants, less the skipped. */
function openGrants(grants, skipped) {
  return grants.filter((g) => g.status === "open" && !skipped.has(g.id));
}

/**
 * Each open grant's flow in list order, one at a time, reading from the fresh
 * state whether it landed. `act(id)` answers with that state plus `error`;
 * `setRunning` is told the id whose flow is running, then null. Resolves with
 * the grant that did not land ({ id, error }) — a throw is a miss like any
 * other — or null once nothing is left, once the owner left the step, or once
 * a grant waits on a relaunch: until then this app's children can't use it,
 * so a later flow (Safari's write) would only fail.
 */
export async function runGrants({ act, getState, setState, stillHere, setRunning }, skipped) {
  for (;;) {
    const { grants } = getState();
    const next = openGrants(grants, skipped)[0];
    if (!next || grants.some((g) => g.status === "relaunch")) return null;
    setRunning(next.id);
    const result = await act(next.id).catch(() => null);
    setRunning(null);
    if (!stillHere()) return null;
    if (!result) return { id: next.id, error: null };
    setState(result);
    const fresh = result.grants.find((g) => g.id === next.id);
    if (fresh?.status === "open") return { id: next.id, error: result.error };
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
