# Security model

Latch lets a remote agent operate this Mac through an approval boundary. Two
ideas hold it up.

## 1. The boundary is owner-authorized capabilities, bound to an authenticated caller

Every operation is a structured intent — a normalized capability set. Before it
runs, it must be **authorized**, and the owner chooses *how* that decision is
made: a fresh per-operation prompt (Ask), a stored always-allow rule keyed on
that exact capability set, a blanket Approve mode, or a delegated AI reviewer
(Adversarial mode). So a given operation may run without a fresh human dialog —
and in Approve or Adversarial mode a human is not in the loop per operation at
all; what is fixed is that it runs only with capabilities the owner's configured
policy authorized. The relay authenticates the calling agent, and that identity
is load-bearing — it is part of the rule key and it scopes always-allow rules,
jobs, and deferred handles, so one agent cannot act on another's. The
per-invocation seatbelt sandbox is *derived from* the authorized capabilities.
The guarantee is therefore narrow and exact: an operation runs only with
capabilities the owner's policy authorized, for that authenticated agent, inside
a sandbox built from those capabilities — **not** that a human personally decides
each one. `DESIGN.md` records how the intent, decision, and sandbox layers fit
together; `docs/SANDBOX-BOUNDARY.md` records what the derived profile permits.

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
  in the literal `argv` the human sees and approves. Passing it positionally
  rather than interpolating it is worth doing when it's free, but it defends the
  caller against itself: it is **not blocking**, and it is never worth a worse
  approval experience.

If you are reviewing and about to raise a caller-hardening finding as blocking,
it belongs on the second list, not the first.
