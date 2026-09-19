/**
 * What a plugin requirement's button does (main's `requirements:act`): a
 * requirement id from pluginsModel.ts, run to the end of its flow, answering
 * whether it is met afterwards. A permission goes to the same act Settings'
 * rows use. Pure over its deps, which main binds to the panel, the
 * connectors and Safari.
 */
import { accountRequirementId, SAFARI_JAVASCRIPT } from "./pluginsModel.js";

export interface RequirementDeps {
  /** The capabilities row's own action, awaited to its end. */
  permission(key: string): Promise<boolean>;
  /** True when that account is connected afterwards. */
  connectAccount(id: string): Promise<boolean>;
  /** The app's own probe — Safari's setting needs it to be written. */
  fullDiskAccess(): Promise<boolean>;
  enableSafari(): Promise<void>;
}

export interface ActResult {
  granted: boolean;
  /** The line the owner reads when the act could not be done. */
  error: string | null;
}

const ACCOUNT_PREFIX = accountRequirementId("");

export async function actOnRequirement(id: string, deps: RequirementDeps): Promise<ActResult> {
  if (id.startsWith(ACCOUNT_PREFIX)) {
    return { granted: await deps.connectAccount(id.slice(ACCOUNT_PREFIX.length)), error: null };
  }
  if (id === SAFARI_JAVASCRIPT) {
    if (!(await deps.fullDiskAccess())) return { granted: false, error: "Safari's setting needs Full Disk Access first." };
    try {
      await deps.enableSafari();
      return { granted: true, error: null };
    } catch (error) {
      return { granted: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { granted: await deps.permission(id), error: null };
}
