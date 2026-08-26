/**
 * What the Vault tab says when it has no list to show — the whole status-to-copy
 * decision, kept pure so it can be exercised without a display.
 *
 * This screen has been rescued from the same mistake twice: a locked account
 * rendered as "has not started yet", which sent people to debug a server that
 * was running fine, and then a build with no runtime rendered the same way,
 * which sent someone looking for a server that had never been installed. Both
 * times the fix was to hand one state a sentence another was already entitled
 * to, so the sentences live together here rather than a branch apart.
 *
 * Returns null when there is a list to show instead — the caller renders it.
 */
export function vaultEmptyState(reply, failure) {
  // A failed call is not a status: nothing was read, so the pane says that
  // rather than diagnosing a vault it never reached.
  if (failure) return null;
  // No guard on a missing reply: the only caller sets `failure` when the call
  // threw, so a null here would be a contract break, and `reply.status` says so
  // at once rather than deferring a TypeError to the list path below.
  if (reply.status === "ready") return null;

  const missing = reply.status === "missing";
  const locked = reply.status === "locked";
  return {
    // Named, not a fall-through. "Has not started yet" is the answer to exactly
    // one status and never to "none of the above" — a fifth outcome added in
    // main.ts, or a packaged renderer left behind by one, has to say something
    // that cannot be mistaken for a diagnosis.
    headline: missing
      ? "This build has no vault installed."
      : locked
        ? "This Mac can't unlock its vault account."
        : reply.status === "starting"
          ? "The vault has not started yet."
          : `The vault reported a state this build does not know: ${reply.status}`,
    // Lead with what is certain and claim no more. All `missing` says is that
    // there is no vault here; whether the browser runtime around it is absent
    // too, or merely missing its vault payload, is a distinction this side
    // cannot make. No remedy either: a packaged install always bundles one, so
    // an owner reading this has a broken install rather than a recipe to run,
    // and the from-source case gets the command on the terminal instead.
    //
    // For `locked`, no invented recovery and no asserting a cause the code
    // cannot tell apart: `undecryptable` is one `catch` covering a wrong key
    // AND a damaged file, so the copy leads with what is certain, names the
    // likely cause as likely, and gives the remedy — the same either way.
    note: missing
      ? "Nothing is lost — a build that includes the vault will open whatever is already here."
      : !locked
        ? null
        : reply.reason === "no-storage"
          ? "The encrypted account is on disk, but this build has no secure storage to open it with. Nothing is lost; a build with secure storage will read it."
          : "The account file is present but cannot be opened. Usually that means the key is no longer in this Mac's Keychain — after a Keychain reset, a restore from backup, or a change to how the app identifies itself — and it can also mean the file itself is damaged. Either way the password cannot be recovered, here or anywhere: the vault would have to be set up again. Nothing has been deleted.",
  };
}
