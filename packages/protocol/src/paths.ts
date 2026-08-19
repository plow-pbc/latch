/**
 * Canonical install locations — twin of DomoProtocol/DomoPaths.swift.
 * Everything honors DOMO_HOME so tests use throwaway roots.
 */
import os from "node:os";

export const DomoPaths = {
  get defaultHome(): string {
    const env = process.env.DOMO_HOME;
    if (env && env.length > 0) return env;
    return os.homedir() + "/Library/Application Support/Plow-Latch";
  },
};
