/** The no-code portion of Verify has one visual owner. It must never stack a
 * step label, a generic network label, an error, and a recovery link. */
export function verifyIdlePresentation({ busy, message }) {
  if (busy) {
    return { kind: "loading", text: "Getting a code from Plow…", action: null };
  }
  if (message) {
    return { kind: "failure", text: message, action: "Try again" };
  }
  return { kind: "idle", text: "", action: "Try again" };
}
