/**
 * Canonical install locations — twin of DomoProtocol/DomoPaths.swift.
 *
 * Domo's own install locations honor DOMO_HOME, so tests use throwaway roots.
 * That is the whole of what it covers: the LTMM fact store is external state,
 * built by a separate CLI the app spawns on launch, and no DOMO_HOME reaches
 * it. An isolated run must set DOMO_LTMM_BIN as well, or a throwaway home still
 * starts a multi-hour build over the owner's real messages.
 */
import os from "node:os";

export const DomoPaths = {
  get defaultHome(): string {
    const env = process.env.DOMO_HOME;
    if (env && env.length > 0) return env;
    return os.homedir() + "/Library/Application Support/Domo";
  },
};
