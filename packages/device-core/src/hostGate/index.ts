/**
 * Host gates: when this Mac itself — not the owner, not the policy — refuses
 * an approved operation, and how that refusal is explained to the agent and
 * the owner. Start at `diagnose.ts`.
 */
export * from "./diagnose.js";
export * from "./errors.js";
export * from "./folderAccess.js";
export * from "./fullDiskAccess.js";
export * from "./guardedPaths.js";
export * from "./inventory.js";
export * from "./probes.js";
