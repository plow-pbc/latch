# plow-wiki (Latch plugin)

Stages [`plow-wiki`](https://github.com/plow-pbc/plow-wiki)'s `wiki` CLI for
an agent driving this Mac through Latch. The wiki itself is a folder of
Markdown pages at `~/Plow/wiki`, opened in Obsidian by the owner and written
by agents and humans alike.

`plow-wiki` is not published to PyPI, so this plugin's manifest stages it as
a **tool binary**: `runtime.binaries[0]` names a git URL and a pinned 40-char
commit instead of a downloaded archive's url/sha256, and the staging code
installs it with `uv tool install git+<git>@<commit>`, redirecting `uv`'s own
tool venv and shim directories into this plugin's `runtime/<arch>/bin` so the
result lands exactly where a downloaded binary would.

## Commands

| Command | Does |
|---|---|
| `wiki init <path>` | Creates the wiki: `AGENTS.md`, `wiki.toml`, `_raw/`, one folder per root, each root's schema |
| `wiki validate` | Checks every page's frontmatter against its root's schema |
| `wiki index` | Regenerates `index.md`, each root's declared tables, and the facts recall embeds |
| `wiki snapshot` | Commits the wiki into `~/Plow/wiki.git` after a credential scan |
| `wiki history <path>` | Commits touching a page |

`validate`, `index` and `history` are read-only; `init` and `snapshot` write,
per the manifest's `argv` allowlist. The CLI defaults to `~/Plow/wiki` when no
`--wiki` / `WIKI_PATH` is given, matching this plugin's `requires.paths`.

## Updating the pin

```sh
git ls-remote https://github.com/plow-pbc/plow-wiki HEAD
```

then bump `runtime.binaries[0].commit` in `latch-plugin.json` to the new
40-character commit. A floating ref (`main`, a tag) is refused at parse time.
