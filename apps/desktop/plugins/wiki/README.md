# wiki (Latch plugin)

Stages [`plow-wiki`](https://github.com/plow-pbc/plow-wiki)'s `wiki` CLI for
an agent driving this Mac through Latch. The wiki itself is a folder of
Markdown pages at `~/Plow/wiki`, opened in Obsidian by the owner and written
by agents and humans alike.

This manifest is vendored from upstream's own `latch-plugin.json` (see
`git ls-remote` below for how the pin was taken), which stages `plow-wiki`
the way `runtime.sources` already exists to be used: `runtime.sources[0]`
names a git URL, a pinned 40-char commit, and an `install` argv
(`uv sync --frozen`), and `stage.ts` clones the repo at that commit into
`runtime/<arch>/plow-wiki` and runs `install` there — `uv` builds the venv
in place, same as it would from a checkout on the owner's own Mac. The commit
hash is the integrity pin; there is no separate digest, the same way a
binary's tar member has none once its sha256 has matched.

Two fields upstream's manifest omits are added here to satisfy this repo's
schema rather than upstream's own design: `exec` (mandatory on every
manifest) points at the source's own directory and its installed `wiki`
entry point, and `requires.paths` names `~/Plow/wiki` for the Plugins tab's
UI — `env.WIKI_PATH` already states the same path for the CLI's own use, so
this is the one place left that repeats it, kept because the UI reads
`requires`, not `env`.

## Commands

| Command | Does |
|---|---|
| `wiki init <path>` | Creates the wiki: `AGENTS.md`, `wiki.toml`, `_raw/`, one folder per root, each root's schema |
| `wiki validate` | Checks every page's frontmatter against its root's schema |
| `wiki index` | Regenerates `index.md`, each root's declared tables, and the facts recall embeds — a write, per upstream: it rewrites files on disk |
| `wiki snapshot` | Commits the wiki into `~/Plow/wiki.git` after a credential scan |
| `wiki history <path>` | Commits touching a page |

`validate` and `history` are read-only; `init`, `index` and `snapshot` write,
per the manifest's `argv` allowlist (`init`/`index`/`snapshot` in
`argv.write`) — this matches upstream's own classification, which counts
`index` as a write since it regenerates files rather than only reading them.

## Updating the pin

```sh
git ls-remote https://github.com/plow-pbc/plow-wiki HEAD
```

then bump `runtime.sources[0].commit` in `latch-plugin.json` to the new
40-character commit. A floating ref (`main`, a tag) is refused at parse time.
