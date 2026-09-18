# wiki (Latch plugin)

Stages [`plow-wiki`](https://github.com/plow-pbc/plow-wiki)'s `wiki` CLI for
an agent driving this Mac through Latch. The wiki itself is an LLM wiki —
Karpathy's pattern, as [obsidian-wiki](https://github.com/Ar9av/obsidian-wiki)
lays it out — kept in an Obsidian vault at `~/Plow/wiki` whose files are an
[OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)
bundle, written by agents and humans alike.

The plugin ships the way `gog` does: a sha-pinned, self-contained `wiki`
binary per architecture under `runtime.binaries`, fetched and verified by
`stage.ts` at packaging time and run from the plugin's own directory. The
binary bundles its own interpreter, so the owner's Mac needs no Python, `uv`
or virtualenv. `WIKI_PATH` is set from `${owner_home}` at dispatch, so the
CLI never needs a `--wiki` flag (which the allowlist refuses anyway).

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

1. In `latch-plugin.json` set `version`, the version segment of both `url`s,
   and both `sha256` values, taken from the release's `checksums.txt`
   (https://github.com/plow-pbc/plow-wiki/releases). A
   stale url downloads the old release and fails the sha check — the pin is
   the sha, the url is where it comes from.
2. Run `just stage-plugins wiki`.
3. Verify the staged binary is what runs, keeping the negative control: a
   `wiki` may already sit on the executor's PATH, so a passing
   `wiki validate` through `DeviceAgent` proves nothing on its own. Delete
   the staged `runtime/<arch>/bin/wiki` and confirm the same dispatch fails
   closed (`execvp … No such file or directory`) instead of falling through
   to PATH.
