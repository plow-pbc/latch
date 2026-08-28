# Security model

Latch lets a remote agent operate this Mac through an approval boundary. Two
ideas hold it up.

## 1. The boundary is human approval + capabilities — not caller authentication

Every operation is a structured intent a human approves, or has pre-approved via
an always-allow rule keyed on the exact normalized capability set. The
per-invocation seatbelt sandbox is *derived from* those approved capabilities.
What protects the user is that a human agreed to **this operation with these
capabilities** — not any judgment about who is calling. `DESIGN.md` records how
the intent, decision, and sandbox layers fit together; `docs/SANDBOX-BOUNDARY.md`
records what the derived profile actually permits.

## 2. The calling agent is trusted; the data it handles is not

An agent reaching this Mac through the relay is a **trusted principal** — it
already holds whatever the human approved. The genuinely untrusted surface is the
**data** that flows through operations: message bodies, web page text, file
contents — a stranger's words the agent reads while holding the user's shell,
vault, and browser. That data is treated as data, never instructions (the
prompt-injection boundary), and never becomes an action without a fresh approval.

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
