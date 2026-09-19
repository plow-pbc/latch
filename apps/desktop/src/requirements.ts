/**
 * What a plugin requirement's button does (main's `requirements:act`): a
 * requirement id from pluginsModel.ts, run to the end of its flow. Whether it
 * landed is read afterwards from fresh state, not reported here. A permission
 * goes to the same act Settings' rows use. Pure over its deps, which main
 * binds to the panel, the connectors and Safari.
 */
import { accountRequirementId, SAFARI_JAVASCRIPT } from "./pluginsModel.js";

export interface RequirementDeps {
  /** The capabilities row's own action, awaited to its end. */
  permission(key: string): Promise<void>;
  connectAccount(id: string): Promise<void>;
  /** The app's own probe — Safari's setting needs it to be written. */
  fullDiskAccess(): Promise<boolean>;
  enableSafari(): Promise<void>;
}

export interface ActResult {
  /** The line the owner reads when the act could not be done. */
  error: string | null;
}

const ACCOUNT_PREFIX = accountRequirementId("");

export async function actOnRequirement(id: string, deps: RequirementDeps): Promise<ActResult> {
  if (id.startsWith(ACCOUNT_PREFIX)) {
    await deps.connectAccount(id.slice(ACCOUNT_PREFIX.length));
  } else if (id === SAFARI_JAVASCRIPT) {
    if (!(await deps.fullDiskAccess())) return { error: "Safari's setting needs Full Disk Access first." };
    try {
      await deps.enableSafari();
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  } else {
    await deps.permission(id);
  }
  return { error: null };
}
