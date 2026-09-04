# Agent eval: how an agent reads this Mac's answers

`just agent-eval` asks a real MCP client and model to act on the answers this
Mac's MCP server gives, and checks that they do what the copy intends: relay a
confirmed `blocked` verdict's owner sentence word for word in one call, share
the evidence and defer when the verdict is only likely, retrieve a pending
handle, and never send the user to System Settings for a file that is merely
missing. It is **not** part of `just test`: it spends model tokens and its
answers are not deterministic, so each case runs several times and must pass
every time.

Three pieces:

- `capture.mjs` freezes the answers. It drives the real server in process —
  `@domo/mcp-server` over `@domo/device-core`, the real seatbelt, a
  `HeadlessPolicy` deciding, this Mac's probes or a scripted seam where a TCC
  state is needed that the capturing machine cannot be put into — and writes
  one vector per case under `vectors/`: the prompt, the tool answers, the
  error flags, and what the reply must and must not do. `manifest.json` is the
  tool list and the server instructions, frozen the same way.
  Re-run after any change to the answers or the copy: `just agent-eval-capture`.
- `stub-server.mjs` is a stdio MCP server that serves the manifest and replays
  one case's answers. Nothing in it touches a Mac. A case scripts every tool a
  model plausibly reaches for on its prompt — the inventory it checks first,
  the shell it falls back to — and where the real server would answer
  differently by what was asked (a run that declares `write_paths`, a probe
  with `whoami` after a surprising exit), a `variants` entry does too.
- `run.mjs` runs `claude -p` once per case per repeat, with only that server
  and only its tools allowed, and grades the transcript. Transcripts and a
  per-run report land under `out/<timestamp>/` (gitignored).

Two bars per case. The pass bar is `names`: the reply points at the right
thing — the System Settings pane, the Locked flag, the waiting dialog — and
makes no more tool calls than the case allows. The strict bar is `includes`:
the owner sentence relayed word for word, which is what the copy asks for.
It is reported as its own column rather than failing the run, because a
model that names the pane and rewords the sentence is a finding about the
copy, not a broken tool. First results (Sonnet, one run each): every case
passes; the sentence is relayed verbatim in none of the blocked cases.

```
just agent-eval                       # every case, 3 runs each, model "sonnet"
just agent-eval blocked-tcc-file      # one case (comma-separate for several)
just agent-eval '' 5 opus             # every case, 5 runs, another model
```

Needs the Claude CLI on `PATH`, signed in (`claude` once, interactively) or
with `ANTHROPIC_API_KEY` in the environment; no other credential, and no
running app — the stub is the server. Roughly 12 cases × 3 runs, 10–20 s each,
four at a time: a few minutes and well under a dollar on Sonnet.

The CLI is expected to hand the server's `instructions` block to the model.
If a case fails in a way that reads as "the model never saw the instructions",
re-run with `--inject-instructions` (`node eval/agent/run.mjs
--inject-instructions …`): that appends them as system prompt. A pass only with
the flag means the client dropped the block, which is a finding about the
client, not the copy.
