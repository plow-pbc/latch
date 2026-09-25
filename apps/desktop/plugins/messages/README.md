# messages (Latch plugin)

Stages [`plow-messages`](https://github.com/plow-pbc/plow-messages)'s
`plow-messages` CLI for an agent driving this Mac through Latch — read access
to the owner's iMessage archive (`~/Library/Messages/chat.db`) and WhatsApp
archive (`~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite`),
with bodies already decoded. WhatsApp is `--app whatsapp` before the verb.
The default is iMessage. `--app` and `--store` after the verb are refused by
the argv allowlist before an intent exists.

The plugin ships the way `gog` and `wiki` do: a sha-pinned, self-contained
`plow-messages` binary per architecture under `runtime.binaries`, fetched and
verified by `stage.ts` at packaging time and run from the plugin's own
directory. The binary bundles its own SQLite and typedstream decoder, so the
owner's Mac needs no extra runtime installed.

## Commands

| Command | Does |
|---|---|
| `plow-messages search [phrase]` | Messages whose body contains phrase, a literal case-insensitive substring |
| `plow-messages thread (--chat-id N \| --handle H...)` | One conversation, oldest first |
| `plow-messages chats` | Recent conversations, with the kind and the guid a send targets |
| `plow-messages unreplied` | Direct chats whose newest real message is inbound |
| `plow-messages --help` | Full usage text — the source of truth for flags |

All five are reads, per the manifest's `argv` allowlist (`argv.write` is
empty) — the CLI has nothing that writes.

`--store PATH` picks the archive to read and is accepted by the binary ONLY
before the subcommand (`plow-messages --store <path> chats`) — a test or an
operator driving the binary directly can use it, but an agent's argv is
matched against `argv.read`/`argv.write`, which name `search`/`thread`/
`chats`/`unreplied`/`--help` starting at argv[1], so `--store` there is
refused before an intent exists. The default is the owner's own store and
needs no flag.

## Updating the pin

1. In `latch-plugin.json` set `version`, the version segment of both `url`s,
   and both `sha256` values, taken from the release's `checksums.txt`
   (https://github.com/plow-pbc/plow-messages/releases). A stale url
   downloads the old release and fails the sha check — the pin is the sha,
   the url is where it comes from.
2. Run `just stage-plugins messages`.
3. Verify the staged binary is what runs, keeping the negative control:
   delete the staged `runtime/<arch>/bin/plow-messages` and confirm the same
   dispatch fails closed (`execvp … No such file or directory`) instead of
   falling through to PATH.
