# The sandbox boundary — handover to the enforcement layer

**Date:** 2026-08-10
**From:** the relay/MCP side (relay, transport, MCP server, agent identity, deferred results)
**To:** whoever owns policy, approval UX, the seatbelt profile and audit semantics

This document exists because our layer advertised an enforcement property we do not own and cannot
deliver. We have corrected our own claims. The underlying behaviour is yours to decide about, and we
make no recommendation about it here.

Everything below was verified against the code at commit `28da7a7`, not inferred from documentation.

---

## 1. The advertised rule, and what actually happens

### What was advertised

Our `run_command` MCP tool told every agent, in the description they read before calling it:

> Run a CLI command on this Mac inside a sandbox limited to the paths you declare here. Declare every
> path you need up front; **undeclared paths are blocked by the sandbox.**

The repo's own `README.md` said commands run "inside an on-the-fly seatbelt sandbox **scoped to
exactly the approved capabilities**".

### What the profile permits

`packages/device-core/src/executor.ts`:

- **`:72–76`** — the user's entire home directory is made readable on every invocation, before any
  declared path is considered:

  ```
  const home = canonicalize(args.home ?? os.homedir());
  lines.push(`(allow file-read* (subpath ${quote(home)}))`);
  ```

  The comment there gives the reason: *"Broad READ of the user's home so tools installed under it and
  their configs/libraries resolve."*

- **`:77–86`** — five directories under home are made **writable** on every invocation, again
  regardless of what was declared:

  ```
  const housekeeping = ["Library/Caches", ".cache", ".config", ".local/state", ".npm"]
  ```

- **`:87–89`** — the agent's declared `read_paths` are appended *after* the above. They can only
  ever widen an already-broad grant; they never narrow it.

So `read_paths` is not a bound on reads. It is a declaration that is shown to the human, recorded in
the audit log, and used to widen the profile beyond the default region.

### Verified, not assumed

Generated profile for `readPaths: ["/tmp/declared"]`, `writePaths: []`, home overridden to
`/Users/example` — every line mentioning home:

```
(allow file-read*  (subpath "/Users/example"))
(allow file-write* (subpath "/Users/example/Library/Caches"))
(allow file-read*  (subpath "/Users/example/Library/Caches"))
(allow file-write* (subpath "/Users/example/.cache"))
(allow file-read*  (subpath "/Users/example/.cache"))
(allow file-write* (subpath "/Users/example/.config"))
(allow file-read*  (subpath "/Users/example/.config"))
(allow file-write* (subpath "/Users/example/.local/state"))
(allow file-read*  (subpath "/Users/example/.local/state"))
(allow file-write* (subpath "/Users/example/.npm"))
(allow file-read*  (subpath "/Users/example/.npm"))
```

And live, through the real `Executor` with **`readPaths: []`** — no declared read paths at all:

```
$ argv = ["/bin/sh", "-c", "wc -c < ~/.zshrc"]
exit_code=0  output=838
```

The command declared no read paths and read a file in the operator's home directory.

## 2. The concrete consequence

An approved `run_command` with **no `read_paths` at all** can read anything under `$HOME` that is
not separately protected by TCC. That includes, on a typical Mac:

- `~/.ssh/` — private keys and `known_hosts`
- `~/.aws/credentials`, `~/.config/gcloud/`, `~/.kube/config` — cloud and cluster credentials
- `~/.gitconfig`, `~/.netrc`, `~/.npmrc`, `~/.pypirc` — tokens in plain text
- shell history (`~/.zsh_history`), which routinely contains secrets pasted on a command line
- browser profile directories, subject to TCC
- `~/.config` and `~/.local/state`, which are additionally **writable** — as are `~/.cache`,
  `~/Library/Caches` and `~/.npm`

The approval dialog shows the human the declared capability set. A command declaring
`read_paths: ["~/Documents/report"]` is displayed as reading that path, and can in fact read every
item in the list above. The human is not being shown a bound; they are being shown a declaration.

Network is denied unless approved (`executor.ts:90–95`), so the default exfiltration route is
closed. That is a mitigation, not the boundary: a command with network approved for a legitimate
reason has both halves.

## 3. What our layer guarantees

Stated plainly so the boundary is legible from your side. These hold at the point where a request
reaches your code, and do not depend on the agent behaving:

- **The calling identity is authenticated by the relay and cannot be influenced by the request.**
  `agent_id` is the credential's own session id, asserted by the relay in the request frame. An agent
  cannot set, spoof or omit it. It never travels in the request body.
- **`agent_id` is the isolation key, and it is a non-empty string.** Malformed shapes — array,
  object, number, boolean, whitespace — are refused before anything is decided or executed
  (`packages/mcp-server/src/handler.ts`). `agent_name` is display-only: `Session.name` is nullable
  and non-unique, so it is never an identity.
- **Paths are canonicalised before you see them.** Every path an agent supplies is resolved to its
  physical target *before* it becomes a capability, so the approval dialog and the audit record show
  the real file — approving `/tmp/report` when that is a symlink to `~/.ssh/id_rsa` displays the key.
  Execution then targets the resolved path rather than re-following the link.
- **Every tool requires an authenticated agent.** A call with no identity is refused before policy
  and before execution; nothing is decided and nothing is audited. (`tools/list` and
  `server/discover` are served without identity by deliberate decision — they return a static
  manifest with no Mac state and no side effect.)
- **Deferred handles are scoped to the agent that created them.** Another agent presenting one gets
  `unknown`, indistinguishable from a handle that never existed.
- **Goal text never reaches the profile.** It is carried for the human to read and is marked
  unverified; the capability set is what is passed to profile generation.

**What we do not guarantee, and never did:** anything about what the generated profile actually
permits. We construct a capability set and hand it to `SandboxProfile.generate`. What that becomes,
and what the kernel then allows, is entirely your layer.

## 4. Also handed over

Two further items, already recorded, in the same area and also yours:

### 4.1 `fixtures/sbpl.json` is inert on every machine but the generator's

The fixture embeds the generating machine's `$HOME`, so its byte-parity assertions
**skip** everywhere else. `packages/device-core/test/sandbox.test.ts:31` renders this as
`"(skipped: fixture from another machine)"` and the test still reports green.

The consequence is that the golden vector which would catch an unintended change to profile
generation does not run in CI, does not run on any developer machine other than the original, and
announces itself as a pass. The sandbox suite is weaker than a green run suggests. The live
execution assertions in that file (write-outside-scope blocked, network deny) do run.

### 4.2 A residual symlink-swap window between decision and open

We close the common case: a path is resolved to its physical target before it becomes a capability,
so the human approves the real target and execution uses the resolved path rather than re-following
the link. Swapping the symlink after approval is therefore inert, and there is a test for it.

What remains open, and needs descriptor-based access to close:

- an **intermediate directory** in the resolved path can be replaced between the decision and the
  open, redirecting the final resolution;
- the **file at the resolved path** can be replaced with a different file in the same window.

Closing either means holding an open file descriptor from the moment of resolution and performing
the operation against that descriptor, rather than re-opening by path. That is a change to how
`FileOps` and `Executor` acquire their targets, which is your layer, and it is why we stopped where
we did rather than attempting it.

## 5. What we changed on our side

We corrected our own overstatements only. We did not touch profile generation.

- `packages/mcp-server/src/tools.ts` — the `run_command` description no longer claims undeclared
  paths are blocked. It now says `read_paths` and `write_paths` are what the owner approves and what
  the audit records, that write access is granted from them, and explicitly that they are **not** the
  full extent of what the command can read.
- `packages/mcp-server/test/mcpServer.test.ts` — the test that asserted the advertised rule now
  states what it actually proves (goal text cannot widen the profile; a path outside the permitted
  region is blocked) and records that it passed only because its fixtures sit under `os.tmpdir()`,
  outside `$HOME`.
- `README.md` — "scoped to exactly the approved capabilities" corrected, with a pointer here.

### Copy we did not change, because it is yours

The approval dialog tells the human, above the capability list:

- `apps/desktop/src/renderer/approval.js:78` — **"This will be allowed to (enforced)"**
- `apps/desktop/src/renderer/approval.js:4` — the file's own note that the *"enforceable 'fine
  print' is the capability set (what the sandbox is built from)"*
- `apps/desktop/src/viewModel.ts:20` — `/** The enforceable capability set — the source of the
  sandbox bound. */`

The word **enforced**, next to a list that is not the enforced bound for reads, is the same
overstatement in the place where it matters most — it is what the human reads at the moment they
decide. We are flagging it rather than editing it, because the approval surface is yours.
