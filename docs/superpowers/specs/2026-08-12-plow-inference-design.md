# Routing adversarial-review inference through the Plow API

**Date:** 2026-08-12
**Status:** approved by head chef in brainstorming; open facts resolved
**Product stage:** internal tool, employee-only installs. No external users.

## Problem

`adversarialReview()` (`apps/desktop/src/adversarialAgent.ts:98`) is the only
place this app performs LLM inference. It talks to Anthropic directly with an
API key the user pastes into Settings. That key is per-user, unbilled to Plow,
and has to be obtained separately from the Plow account the app already has.

Move the inference to Plow's API so it bills to the user's Plow account and
uses existing credits, while keeping the pasted Anthropic key as an alternate
provider.

## Non-goals

- **Changing what the classifier does.** The verdict stays three-valued
  (`allow` / `deny` / `ask` plus a `reason`), the system prompt is unchanged,
  the fail-closed-to-`ask` posture is unchanged. This is a transport change.
- Keychain/`safeStorage` migration for stored credentials.
- Fixing the pre-existing plaintext-key exposure to the renderer
  (`settings:getApiKey`, `apps/desktop/src/main.ts:374`). Noted below as a
  known issue; out of scope for this change.

## Established facts

Researched and cited; do not re-derive.

**This repo:**
- Sole inference site `adversarialReview()`, `apps/desktop/src/adversarialAgent.ts:98`.
  Model `claude-haiku-4-5`, `thinking` budget 2048, `output_config` JSON schema,
  30s timeout, `maxRetries: 0`, fails closed to `ask` on every error path.
- Sole caller `ElectronPolicy.decideIntent()`, `apps/desktop/src/main.ts:71`.
- Anthropic key: `Settings.anthropicApiKey`, `apps/desktop/src/settings.ts:57`,
  in `$DOMO_HOME/app/settings.json`, written `0600`.
- Plow account client `apps/desktop/src/plowApi.ts`. Stores
  `Settings.relayCredential` / `accountUid` / `mcpUrl`. Base URL baked in at
  build time (`resolveApiBaseUrl`, `plowApi.ts:45`), prod `https://api.plow.co`.
- Settings pane is `renderSettings()` in `apps/desktop/src/renderer/main.js`
  (~`:400-543`), four groups built by a `group(title, desc, body)` helper.
  Existing interlock precedent: the `adversarial` approval chip is disabled
  without a key and clearing the key falls back to `ask` (`main.js:479-511`).
- Inference is fully mocked in tests via `vi.mock("@anthropic-ai/sdk")`,
  `apps/desktop/test/adversarialAgent.test.ts:18`.

**Plow API (`~/plow-pbc/plow`, read-only reference):**
- `POST /v1/chat/completions`, `api/plow/llm/router.py:93`. OpenAI
  chat-completions shape. Auth `Authorization: Bearer <token>`.
  Guard `require_scope("llm","chat")`.
- Forwards only the fields in `_OPTIONAL_FIELDS` (`llm/router.py:49`);
  everything else is silently dropped. `output_config` and `thinking` are
  currently dropped.
- Model allowlist `api/plow/config.py:12-21`. Default is
  `anthropic/claude-sonnet-5`, which is already allowlisted.
- Errors: `402` insufficient balance; `400` model not allowed; provider `401`/
  `403`/`408` are masked as an opaque `502` — **a 502 does not mean "retry with
  different credentials"**. Streaming errors arrive as HTTP 200 with an error
  chunk (not relevant here; this client never streams).
- Billing: an `llm_usage` row per call, cost × 1.10 markup, attributed by
  `user_id` + `session_id`.
- Device credentials are minted with `DEVICE_SCOPES = ["relay:device"]`
  (`api/plow/relay/router.py:37`), which does **not** satisfy `llm:chat`.
  Scopes are frozen at mint time.

**Claude Code's auto-mode classifier** was observed at runtime (Claude Code
2.1.229) calling `claude-sonnet-5[1m]` for its stage-1 filter, while Anthropic's
published engineering post describes the classifier as running on Sonnet 4.6.
Head chef asked to match Claude Code.

**litellm 1.82.2** (pinned via `api/uv.lock:1119`, installed `--frozen`) decides
how `response_format` reaches Anthropic by a hardcoded substring list at
`llms/anthropic/chat/transformation.py:981-994`. Models in that list
(`sonnet-4-6`, `opus-4-6`, `sonnet-4-5`, `opus-4-5`, `opus-4-1`) take the
**native** `output_format` route. Models outside it — including
`claude-sonnet-5` and `claude-opus-4-8` — take a **tool-use emulation** route.

That distinction is decisive here. On the emulation route, the forced
`tool_choice` is applied **only when thinking is off**
(`transformation.py:1009-1015`), because Anthropic forbids forced tool use with
extended thinking. So on `claude-sonnet-5`, sending both `response_format` and
`thinking` transports both but leaves the JSON tool merely *offered* rather than
required: schema-constrained output degrades from a guarantee to a likelihood.
`claude-sonnet-4-6` has no such conflict — native `output_format` needs no
`tool_choice`, and schema plus thinking coexist cleanly.

`thinking` passthrough itself is supported for all three models
(`supports_reasoning: true`).

## Design

### Provider seam

`adversarialReview()` keeps its **contract**: same `Verdict` out, same
fail-closed behavior, same prompt. Its argument type does change — `provider`
is a required field, not a defaulted one, and provider credentials ride
alongside it. A default of `"plow"` would silently switch the live reviewer
onto an unwired path and a default of `"anthropic"` would contradict this
spec, so requiring it makes the compiler find every call site. Internally it
dispatches to one of two providers:

- **`plow`** (default) — `POST {apiBase}/v1/chat/completions` with the stored
  `relayCredential` as a bearer token, model **`claude-sonnet-4-6`**, sending
  `response_format` (JSON schema, the existing `VERDICT_SCHEMA`) and `thinking`
  (`{type: "enabled", budget_tokens: 2048}`), plus `max_tokens: 4096`.

  **Why `claude-sonnet-4-6` and not `claude-sonnet-5`.** The non-goal above says
  classifier behavior does not change, which means keeping both the schema
  guarantee and extended thinking. On litellm 1.82.2 those two are mutually
  exclusive on `claude-sonnet-5`: enabling thinking drops the forced
  `tool_choice` and the model may answer in prose. `claude-sonnet-4-6` takes the
  native `output_format` route where both hold. It is already on Plow's
  allowlist, and it matches the model Anthropic's published engineering post
  attributes to the auto-mode classifier. Head chef's instruction was to match
  Claude Code; where the runtime observation and the published description
  disagree, this picks the one that does not silently weaken a security
  classifier's output guarantee.

  Never send `temperature` on this path: litellm preserves it and Anthropic
  rejects a non-default temperature alongside extended thinking.
  Keep `budget_tokens < max_tokens`; litellm only auto-raises `max_tokens` when
  the caller sends none, and a violation surfaces as an opaque provider 400.
- **`anthropic`** — the existing Anthropic SDK path, unchanged.

Everything shared — the system prompt, `buildPrompt()`, `agentHistory()`, the
timeout race, the fail-closed mapping — stays in one place and is used by both.
The providers differ only in how a prompt becomes a `Verdict`.

### Settings and UI

- New `Settings.inferenceProvider: "plow" | "anthropic"`, defaulting to
  `"plow"`. Absent field reads as `"plow"`.
- A fifth settings group, "Reviewer inference", with two chips (`Plow account`
  / `Anthropic API key`), following the existing chip pattern.
- Interlock, mirroring the existing key interlock: a provider whose credential
  is missing is disabled and cannot be selected. If the active provider loses
  its credential, approval mode falls back to `ask` exactly as it does today
  when the key is cleared.
- The renderer is never given the relay credential — it receives only booleans
  describing which providers are available.

### Credential handling

The relay credential rides in the `Authorization` header and nowhere else.
Never in a URL, never in a log line, never in an error string, never in the
audit log, never handed to the renderer. This is the CLAUDE.md rule and it is
the highest-severity constraint in this change.

### Error handling

Every failure resolves to `ask`, as today. On top of that:
- `402` → `ask` with a reason naming insufficient Plow balance, so the human
  sees why the reviewer abstained.
- `400` → `ask` with a reason naming the model rejection.
- `502` → `ask` with a generic upstream-failure reason. Do **not** treat it as
  an auth problem or prompt for re-credentialing.
- Timeout, transport error, malformed body → `ask`, as today.

### Server-side change (`~/plow-pbc/plow`)

Additive and backwards compatible; must not affect plow.app's existing callers
(plowd's file-catalog ranking and openclaw's provider block), neither of which
sends the newly forwarded fields.

1. `DEVICE_SCOPES` at `api/plow/relay/router.py:37` gains `llm:chat`.
   **`relay:call` must not be touched** — it is what remote agents and
   claude.ai OAuth tokens carry, and they must never be able to spend account
   credits. No wildcard (`relay:*`, `llm:*`) anywhere in this change.
2. `_OPTIONAL_FIELDS` at `api/plow/llm/router.py:49` gains `"response_format"`
   and `"thinking"`. That single tuple feeds both the streaming and
   non-streaming calls (`:117`, `:146`, `:242`), so one edit covers both.
   Additionally declare both fields on `ChatCompletionRequest`
   (`api/schemas/plow_schemas/api/llm.py`, alongside `tools`/`tool_choice`) —
   they would otherwise ride through as unvalidated extras with no OpenAPI
   presence, turning a malformed `thinking` into an opaque 502.

   This is additive: the tuple is a forward-allowlist, so callers that do not
   send these fields build an identical upstream call. plowd's `_broker_chat`
   sends only `model` + `messages`, and openclaw's provider block sends neither
   field, so plow.app is provably unaffected. Response shape is also preserved:
   litellm lifts tool-call arguments back into `choices[0].message.content`
   (`transformation.py:1442-1456`), and thinking output arrives as purely
   additive fields.

Existing employee installs re-activate to pick up the new scope. No backfill
migration; there are no external installs.

## Chunks

### Global Constraints

These hold for every chunk. Cooks see one chunk at a time and never each
other's.

- **The Plow credential never appears in a URL, a log line, an error string,
  the audit log, or anything handed to the renderer.** Only in the
  `Authorization` header. Violating this is a Critical finding.
- **The classifier's behavior does not change.** Three-valued verdict
  (`allow`/`deny`/`ask`) plus `reason`; same system prompt; fails closed to
  `ask` on every error path including no-credential, timeout, refusal,
  malformed output, and any HTTP error.
- **No wildcard scopes.** Not `relay:*`, not `llm:*`. `relay:call` must remain
  unable to reach inference.
- **Testing is a deliverable** (CLAUDE.md). Every behavior reachable by
  `npx vitest run` with no UI and no human. No network in unit tests.
- Everything honors `DOMO_HOME`.
- Do not reformat or refactor code you did not need to change.
- The two repos are separate PRs. Do not mix changes across them.

### Chunk 1: Provider seam in `adversarialReview()`

Implements: §Design/Provider seam.
Interfaces: consumes `Settings`; produces the internal provider interface that
Chunks 2–4 build on.
Done when: `npx vitest run` passes; new tests prove the Anthropic path is
byte-for-byte unchanged in the request it builds, and that a provider selection
of `plow` with no credential fails closed to `ask` without any network call.

### Chunk 2: Plow provider — request, structured output, error mapping

Implements: §Design/Provider seam (plow), §Design/Error handling.
The request carries `response_format` (`VERDICT_SCHEMA`) and `thinking`; the
verdict is read from `choices[0].message.content` as a JSON string. Model
`claude-sonnet-4-6`. No `temperature`.
Interfaces: consumes the provider interface from Chunk 1; produces a `Verdict`.
Done when: unit tests cover a clean verdict, each error code's mapping
(402/400/502/timeout/malformed), and an assertion that the credential appears
in no log, error, or serialized output.

### Chunk 3: Settings field, IPC, and the interlock

Implements: §Design/Settings and UI.
Interfaces: consumes `Settings.inferenceProvider`; produces the IPC surface the
renderer uses.
Done when: `npx vitest run` passes including a new test for
`ElectronPolicy.decideIntent()`'s provider/mode branching (currently untested);
the renderer receives availability booleans and never a credential.

### Chunk 4: Settings UI group

Implements: §Design/Settings and UI.
Interfaces: consumes the IPC surface from Chunk 3.
Done when: `just verify-preload` passes and a screenshot of the running app
shows the new group with the interlock behaving (unavailable provider
disabled).

### Chunk 5: Server change in `~/plow-pbc/plow`

Implements: §Design/Server-side change.
Interfaces: produces the scope grant and field forwarding the Plow provider
depends on.
Done when: the repo's own test suite passes; a test proves a `relay:call`
credential still receives 403 from `/v1/chat/completions`; and evidence that a
request without the newly forwarded fields produces an unchanged upstream call.

## Testing

Unit tests mock `fetch` for the Plow path exactly as the existing suite mocks
the Anthropic SDK. No network, no UI, no human.

The final end-to-end pass is separate and does hit the real API: a real request
to `https://api.plow.co/v1/chat/completions` producing a real verdict, captured
with the response body, plus screenshots of the running app. Because the
`DEVICE_SCOPES` change will not be deployed at that point, the e2e uses a
token that already carries `llm:chat` to prove the request shape and the
client are correct; the scope grant is verified separately in Chunk 5.

## Known issues, not addressed here

- `settings:getApiKey` (`apps/desktop/src/main.ts:374`) returns the plaintext
  Anthropic key to the sandboxed renderer, which is a weaker posture than the
  relay credential gets (`hasCredential` boolean only, `main.ts:312`). Worth a
  follow-up.
- `adversarialAgent.ts` uses the pre-4.6 `thinking: {type:"enabled",
  budget_tokens}` shape. Correct for `claude-haiku-4-5`, but any move to a
  4.6+ model on the Anthropic path requires `thinking: {type:"adaptive"}` plus
  `output_config.effort`.
