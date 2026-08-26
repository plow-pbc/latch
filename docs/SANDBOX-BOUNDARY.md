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

- **the broad home read** — the user's entire home directory is made readable on every invocation, before any
  declared path is considered:

  ```
  const home = canonicalize(args.home ?? os.homedir());
  lines.push(`(allow file-read* (subpath ${quote(home)}))`);
  ```

  The comment there gives the reason: *"Broad READ of the user's home so tools installed under it and
  their configs/libraries resolve."*

- **the `housekeeping` constant** — five directories under home are made **writable**, regardless of what was
  declared:

  ```
  const housekeeping = ["Library/Caches", ".cache", ".config", ".local/state", ".npm"]
  ```

  With one exception, and it is the only place a declaration narrows this profile rather than
  widening it: a **reapable** run — one that declared no write paths and no network, and so may be
  killed for going silent (`REAP_AFTER_MS`) — does not get them. A run that can be shot mid-write
  must have nowhere persistent to write; its scratch, which dies with it, stays writable.

- **the declared-read loop** — the agent's declared `read_paths` are appended *after* the above. They can only
  ever widen an already-broad grant; they never narrow it.

So `read_paths` is not a bound on reads. It is a declaration that is shown to the human, recorded in
the audit log, and used to widen the profile beyond the default region.

### Verified, not assumed

Generated profile for `readPaths: ["/tmp/declared"]`, `writePaths: []`, `network: true`, home
overridden to `/Users/example` — every line mentioning home. Network approved, so this run is not
reapable and keeps the housekeeping writes:

```
(allow file-read* (subpath "/Users/example"))
(allow file-write* (subpath "/Users/example/Library/Caches"))
(allow file-read* (subpath "/Users/example/Library/Caches"))
(allow file-write* (subpath "/Users/example/.cache"))
(allow file-read* (subpath "/Users/example/.cache"))
(allow file-write* (subpath "/Users/example/.config"))
(allow file-read* (subpath "/Users/example/.config"))
(allow file-write* (subpath "/Users/example/.local/state"))
(allow file-read* (subpath "/Users/example/.local/state"))
(allow file-write* (subpath "/Users/example/.npm"))
(allow file-read* (subpath "/Users/example/.npm"))
```

The same inputs with `network: false` are the exception above — reapable, so the five writes are
gone and only their reads remain:

```
(allow file-read* (subpath "/Users/example"))
(allow file-read* (subpath "/Users/example/Library/Caches"))
(allow file-read* (subpath "/Users/example/.cache"))
(allow file-read* (subpath "/Users/example/.config"))
(allow file-read* (subpath "/Users/example/.local/state"))
(allow file-read* (subpath "/Users/example/.npm"))
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

Network is denied unless approved (the `args.network` branch of `SandboxProfile.generate`), so the default exfiltration route is
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

Four further items in the same area, all yours:

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

### 4.3 The approval dialog claims the capability list is enforced

This is the same overstatement as §1, in the place where it matters most — what the human reads at
the moment they decide:

- `apps/desktop/src/renderer/approval.js:78` — the label above the capability list reads
  **"This will be allowed to (enforced)"**
- `apps/desktop/src/renderer/approval.js:4` — the file's own note that the *"enforceable 'fine
  print' is the capability set (what the sandbox is built from)"*
- `apps/desktop/src/viewModel.ts:20` — `/** The enforceable capability set — the source of the
  sandbox bound. */`

How fair the list is depends on which capability, and it is only fully fair for one of them:

| Shown | Actually enforced? |
|---|---|
| `Read: …` (any) | **No.** Per §1 the profile permits the whole home directory regardless of what was declared. |
| `Write: …` on a **`write_file`** call | **Yes.** `FileOps.write` canonicalises and scope-checks against the approved paths, and refuses outside them. |
| `Write: …` on a **`run_command`** call | **No.** The profile additionally grants writes to the five housekeeping directories under home, whatever `write_paths` says — except for a reapable run, which gets none of them. §1 states that rule; this row does not restate it. |
| `Run: …` | Yes, in that the argv shown is the argv executed. |
| `Network: denied` | Yes — the `args.network` branch of `SandboxProfile.generate`. |

So a human approving only `Write: /tmp/report` on a command is not being shown the full writable set
either, and a human approving any `Read:` is being shown something that is not the bound at all.

We corrected the equivalent wording in our own tool descriptions and docs (§5). We have not touched
this copy, because the approval surface is yours and the right wording depends on what you decide to
do about §1.

### 4.4 The same claim reaches the automated reviewer, which can approve without a human

This one is worse than the dialog, because there is no person in the loop to apply judgement.

The adversarial reviewer is told the same untrue thing, twice:

- `apps/desktop/src/adversarialAgent.ts:34` — the system prompt instructs it to *"judge by the
  concrete command and the requested capability bounds **(which is what the sandbox will actually
  enforce)**"*
- `apps/desktop/src/adversarialAgent.ts:78` — each request is labelled *"Requested capability bounds
  **(what the sandbox will enforce if allowed)**"*

And in adversarial approval mode, its verdict is acted on directly:

- `apps/desktop/src/main.ts:86-88` — `if (verdict === "allow") return { decision: "allow_once",
  source: "adversarial" }`. No dialog is opened. No human sees it.

So a model is being asked to reason about risk from a description of the enforced bound that is not
the enforced bound, and its answer can approve the operation outright. A reviewer told that
`Read: ~/Documents/report` is what the sandbox will enforce has no way to know the command can also
read `~/.ssh` — and it is precisely the reads it is being asked to judge (its own prompt names
`~/.ssh`, `.env` files and credential stores as deny-worthy).

The remedy is yours: it depends on what you decide about §1, and on whether the prompt should
describe the declared set or the enforced one. We are not proposing either.

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

The approval dialog's own "enforced" label — see §4.3, where it is handed over alongside the other
items in this area.
