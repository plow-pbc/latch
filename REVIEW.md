# Review instructions — domo-desktop

What is different about reviewing *this* repo: the operating point, the accepted
deferrals, and the one carve-out where defensive code earns its keep. Universal
review policy — voice posture, decline rules, review-loop rules — is not here;
the reviewer prepends its own copy to every agent, so it does not need restating.

## Product context

**What it is.** "Plow Latch": an Electron + TypeScript Mac app that lets a remote
AI agent use a Mac — files, CLI, a real browser — through intent-based human
approval and a per-invocation seatbelt sandbox. `DESIGN.md` records the
decisions and their rationale; `CLAUDE.md` carries the invariants a change must
not break. Read the **base-branch** copies of both before judging an
architectural tradeoff.

**Stage:** pre-PMF; the broker is gone and a Mac dials out to the relay. That
relay lives in another repo, and it is **built and serving: agents do reach
Macs through this app today.** Treat the paths an agent drives — approval,
capability derivation, the sandbox, origin and credential enforcement — as live
surface with a real caller on the other end, not as a design not yet exercised.

**Userbase:** single-digit, internal. One engineer plus a handful of alpha
machines. The signed/notarized DMG and the S3 update feed exist and work, but
they serve that same group — a packaged release is not evidence of scale.

**Architectural commitments** (don't propose replacing these unless the PR does):
- npm workspaces, TypeScript, Node + Electron. Libraries in `packages/`, apps in
  `apps/`. No server process; the app is the device.
- **Capabilities are derived on this Mac from tool arguments.** An agent never
  sends a capability set or an intent. Goal text is display-only and must never
  reach a decision path — not the rule key, not the sandbox profile.
- **`fixtures/` is the frozen protocol spec.** Canonical JSON, grant signing
  bytes, rule keys and SBPL profiles are asserted against it. A diff that
  changes those bytes is a protocol break and must say so.
- **`agent_id` is the isolation key; `agent_name` is display-only** and is
  neither unique nor non-null.
- **Nothing may block past the 20s relay call budget** — that is why file ops
  are async and size-capped, and why slow tools return a deferred handle.
- The renderer is sandboxed (`contextIsolation` on, `nodeIntegration` off,
  strict CSP, no remote content) and reaches main only through `preload.cts`.
- Everything honors `DOMO_HOME`, so tests use throwaway roots.

**Accepted deferrals — known, recorded, not new findings.** Re-raising one of
these costs a review slot and teaches the author to skim:
- **The sandbox is broader than the tool description implies.** Home is readable
  and five housekeeping dirs are writable on every invocation, before declared
  paths are considered. This is documented in `docs/SANDBOX-BOUNDARY.md` and
  owned. Flag it only when a diff *widens* it further or re-advertises the tight
  bound the code does not deliver.
- **The device private key is a plaintext seed in a `0600` file.** No Keychain,
  no `safeStorage`. It is on the roadmap (DESIGN.md §12), not an oversight.
- **There is no automated live-stack test.** The stand-in relay was deleted
  deliberately; the relay leg is verified by hand against a local Plow API
  (`docs/TESTING-THE-APP.md`). "Add an integration test for this" is not an
  available remedy — say "verify by hand and report what you saw" instead.
- **The browser evidence buffer is destructive and unserialized** —
  issue #104, declined with the reachability conditions named.

**Reviewer environment note:** `just test` is `npx vitest run` and needs
`npm install` first. A reviewer checkout without it reports a collection failure
that has nothing to do with the PR — read it as "tests not run", never as a
PR-introduced failure, and never let it become a `Class: tests` finding.

## Review priority

**Cultural emphasis: scope creep is the defect that costs most here.** PRs on
this repo routinely land at four figures of additions across a dozen-plus files,
and the growth is almost always a feature growing a lifecycle, a retention
policy, a cache or a capacity limit that nothing has asked for. Subtractive
remedies outrank additive ones at every severity. A `[simplification]` probe
whose honest answer is "no, this isn't needed" should land as a **deletion** in
the next push, not as a new guard that absorbs the probe. When the same class of
finding recurs across three rounds, stop probing leaves and name the one seam
change that retires the class.

**The one carve-out: enforcement code is the product, and it is not bloat.**
The org default ("almost no defensive branch earns its keep at ten users") does
**not** license simplifying away a check on these paths, because a wrong answer
here is the whole failure mode the app exists to prevent:
capability derivation and normalization · rule keys and always-allow matching ·
the generated seatbelt profile · per-agent and per-session authorization ·
origin and credential enforcement in the browsing subsystem · anything touching
the relay credential · canonical JSON and the signing bytes · the renderer
boundary. Keep the bar high there and low everywhere else. The tell for which
side you are on: does the branch enforce a bound a human approved, or does it
manage a resource nobody has run out of?

| Scope creep — DON'T | Worth blocking on — DO |
|---|---|
| Accept a retention/eviction/capacity layer added to bound a resource with no observed pressure signal (PR #91's profile reaper — deleted, and its startup ordering was itself a data-loss bug). | An authorization gap: one agent acting on another's session, browser, handle or rule (PR #100's cross-agent close). |
| Ask for a new abstraction, registry or manager to hold state an existing owner already holds (PR #100's `BrowserPool` shadowing `BrowserSessions`). | A secret or credential reaching a log line, an error string, a URL, the audit log, or the renderer — in any encoding. |
| Ask for an integration test that would need a server stood up. Mocking here is function- and fixture-level only. | A capability, rule key or sandbox profile that goal text can influence. |
| Add a defensive branch for a state the pinned dependency cannot produce (PR #103's partial-response record — deleted once the API was checked). | A change to canonical JSON, signing bytes, rule keys or SBPL that moves `fixtures/` bytes without declaring a protocol break. |
| Clone a test to vary one input. Collapse into `it.each`; assert on `audit.ndjson` events rather than internal state. | A path shown to the human that was not canonicalized before it became a capability. |

**Update cadence:** edit this file when the operating point moves — the relay
lands, real external users arrive, or an accepted deferral above is resolved.
Otherwise it is static.
