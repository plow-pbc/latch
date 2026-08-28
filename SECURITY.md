# Security model

Latch lets a remote agent operate this Mac through an approval boundary. Two
ideas hold it up.

## 1. The boundary is owner-authorized capabilities, bound to an authenticated caller

An operation is described by a normalized **capability set**, and it runs only if
the owner's configured policy authorizes that set. The owner chooses *how* each
decision is made: a fresh per-operation prompt (Ask), a stored always-allow rule
keyed on that exact set, a blanket Approve mode, or a delegated AI reviewer
(Adversarial mode) — so an operation may run with no human in the loop for it;
what is fixed is that it ran under an authorization the owner configured. The
relay authenticates the calling agent, and that identity is load-bearing: it is
part of the rule key and it scopes always-allow rules, jobs, and deferred
handles, so one agent cannot act on another's.

How that authorization is *enforced* differs by operation and is not uniform: a
shell command runs under a seatbelt profile derived from its capabilities; file
and browser operations enforce their own capability-specific checks; and a
browser session's later commands ride the session's original grant rather than
minting a fresh decision each time. This document states the security
**posture**, not the pipeline — `DESIGN.md` is canonical for the intent,
decision, and enforcement layers, and `docs/SANDBOX-BOUNDARY.md` for what a
derived seatbelt profile permits.

## 2. The calling agent is trusted; the data it handles is not

An agent reaching this Mac through the relay is authenticated and treated as a
**trusted principal** — it already holds whatever the owner's policy authorized. The
genuinely untrusted surface is the **data** that flows through operations: message
bodies, web page text, file contents — a stranger's words the agent reads while
holding the user's shell, vault, and browser. That data is treated as data, never
instructions (the prompt-injection boundary). Untrusted data cannot expand the
approved capability set or cross into an action outside it — but note that, within
an already-approved set, a stored rule or Approve mode lets a matching operation
proceed without a fresh prompt, so the boundary is the capability grant, not a
per-message dialog.

We *do* try to defend against a malicious caller too — but never at the expense
of the user's experience, and such caller-hardening is **defense-in-depth, not a
guarantee**: take it when it costs the user nothing, don't let it block a change,
and never trade UX for it.

## What this means for hardening

The line that decides whether a hardening finding is load-bearing:

- **Untrusted data crossing into an action is in scope, and can block.** A
  message body an agent relays is passed as an `argv` item, never interpolated
  into a script string, because that body can carry a stranger's text that would
  otherwise parse as automation. Goal text must never influence a capability,
  rule key, or sandbox profile.
- **A trusted caller's own arguments are defense-in-depth.** An identifier the
  agent chose — a phone number, a chat GUID it read from the local store — sits
  in the literal `argv` the owner's policy authorizes (and that a human sees in
  Ask mode). Passing it positionally rather than interpolating it is worth doing
  when it's free, but it defends the caller against itself: it is **not
  blocking**, and it is never worth a worse approval experience.

If you are reviewing and about to raise a caller-hardening finding as blocking,
it belongs on the second list, not the first.
