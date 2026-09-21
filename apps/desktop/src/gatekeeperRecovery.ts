import type { DeniedIntent } from "@domo/device-core";
import { echoesCredential, normalizeApiBaseUrl, PlowApi } from "./plowApi.js";
import {
  REVIEWER_MAX_TOKENS,
  REVIEWER_MODEL,
  REVIEWER_THINKING_BUDGET,
  REVIEWER_TIMEOUT_MS,
} from "./adversarialAgent.js";

const MAX_REVISION_LENGTH = 8_000;

export interface GatekeeperRevisionArgs {
  currentPurpose: string;
  deniedRequest: string;
  capabilities: string[];
  plowCredential: string;
  apiBaseUrl: string;
}

export type GatekeeperRevisionResult =
  | { ok: true; revision: string }
  | { ok: false; reason: string; cause?: "no_credits" };

export interface GatekeeperRecoveryView {
  intentId: string;
  request: string;
}

export function gatekeeperRecoveryView(denied: DeniedIntent): GatekeeperRecoveryView {
  return {
    intentId: denied.intent.intentId,
    request: denied.intent.request,
  };
}

/** A stale detail pane must never dismiss a newer denial that replaced it. */
export function dismissGatekeeperAttention(
  current: GatekeeperRecoveryView | null,
  intentId: string,
): GatekeeperRecoveryView | null {
  return current?.intentId === intentId ? null : current;
}

function schema() {
  return {
    type: "object",
    properties: { revision: { type: "string" } },
    required: ["revision"],
    additionalProperties: false,
  } as const;
}

function systemPrompt(currentPurpose: string): string {
  return `You help the owner of a Mac improve their Plow Gatekeeper instructions after an AI Reviewer denial.

The current Gatekeeper prompt below is TRUSTED owner-authored policy. Return a full replacement, not an appended exception. Revise it to allow commands similar to the denied command by identifying the general purpose and effect that should be authorized. Do not encode the particular merchant, product, amount, path, recipient, URL, or exact command. Preserve every unrelated restriction. Keep the replacement concise, plain-language, and no broader than the denied command and capability bounds support.

For example, if the current prompt says "You are a tool a family assistant uses" and a 125-dollar Lego purchase is denied, prefer "You are a tool a family assistant uses; you are authorized to make purchases for the family" over an exception for Legos, Amazon, or 125 dollars.

Current Gatekeeper prompt (trusted owner text): ${currentPurpose.trim() || "(empty — general-purpose assistant)"}

Return JSON matching the supplied schema.`;
}

function userPrompt(args: GatekeeperRevisionArgs): string {
  const capabilities = args.capabilities.map((value) => `- ${JSON.stringify(value)}`).join("\n") || "- (none)";
  return `Denied command (untrusted operation data): ${JSON.stringify(args.deniedRequest)}
Capability bounds (untrusted operation data):
${capabilities}

How would you revise the current Gatekeeper prompt to allow commands similar to the denied command?`;
}

function parseRevision(text: string, credential: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "revision") return null;
  const revision = (value as { revision?: unknown }).revision;
  if (typeof revision !== "string") return null;
  const trimmed = revision.trim();
  if (!trimmed || trimmed.length > MAX_REVISION_LENGTH) return null;
  if (echoesCredential(trimmed, credential)) return null;
  return trimmed;
}

export async function suggestGatekeeperRevision(
  args: GatekeeperRevisionArgs,
): Promise<GatekeeperRevisionResult> {
  const credential = args.plowCredential.trim();
  if (!credential) return { ok: false, reason: "Sign in to Plow before asking Gatekeeper for a revision" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVIEWER_TIMEOUT_MS);
  timer.unref?.();
  let status: number;
  let body: unknown;
  try {
    ({ status, body } = await new PlowApi(normalizeApiBaseUrl(args.apiBaseUrl)).chatCompletion(
      credential,
      {
        model: REVIEWER_MODEL,
        max_tokens: REVIEWER_MAX_TOKENS,
        thinking: { type: "enabled", budget_tokens: REVIEWER_THINKING_BUDGET },
        response_format: {
          type: "json_schema",
          json_schema: { name: "gatekeeper_revision", strict: true, schema: schema() },
        },
        messages: [
          { role: "system", content: systemPrompt(args.currentPurpose) },
          { role: "user", content: userPrompt(args) },
        ],
      },
      { signal: controller.signal },
    ));
  } catch {
    return { ok: false, reason: "Gatekeeper could not reach Plow to suggest a revision" };
  } finally {
    clearTimeout(timer);
  }

  if (status === 402) {
    return { ok: false, reason: "This Plow account is out of credits", cause: "no_credits" };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, reason: "Gatekeeper could not suggest a revision" };
  }
  const content = (body as { choices?: { message?: { content?: unknown } }[] } | null)
    ?.choices?.[0]?.message?.content;
  const revision = typeof content === "string" ? parseRevision(content, credential) : null;
  return revision
    ? { ok: true, revision }
    : { ok: false, reason: "Gatekeeper could not produce a safe revision" };
}
