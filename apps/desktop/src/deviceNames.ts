/** The server owns collision-safe device names; the hostname is only a fallback before registration. */
export function deviceDisplayName(
  registeredDisplayName: string | null | undefined,
  hostname: string | null | undefined,
): string {
  return registeredDisplayName?.trim() || hostname?.trim() || "Mac";
}

/**
 * Name the login session created by this Latch without duplicating composition
 * in Electron main. This must never be blank: cleanup distinguishes named
 * sign-in sessions from unnamed provisioned sessions, and a blank name would
 * make this Mac's own session a revocation candidate.
 */
export function latchSessionName(
  registeredDisplayName: string | null | undefined,
  hostname: string | null | undefined,
): string {
  return `Plow Latch (${deviceDisplayName(registeredDisplayName, hostname)})`;
}
