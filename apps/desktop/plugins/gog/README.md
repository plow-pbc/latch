# gog — the pin-bump checklist

Bumping gog's pin — the whole checklist, and its only home. (The vendored
copy of this checklist in `scripts/vendored-providers.mjs` is retired by
the next PR in this stack — this one is the "only home" that stands.)

Per-version verdicts about gog's own grammar. They live on gog's row rather
than in the fetcher, which knows nothing about any particular CLI.

1. Set `version` in `latch-plugin.json` and both `sha256` values (the
   tarballs, checked against upstream's `checksums.txt`).
2. Run `just stage-plugins gog`; the postinstall hook asserts no gog flag is
   negatable.
3. Re-run these six BY HAND against the new binary. The first five are
   spellings that would disarm a belt flag while matching neither the
   reserved set nor either rule; all five are `unknown flag` at 0.36.0:

   ```
   gog gmail send … --no-readonly
   gog gmail send … --no-wrap-untrusted
   gog gmail send … --no-gmail-no-send
   gog gmail send … -readonly=false
   gog gmail send … -readonly false
   ```

   The sixth is not a disarming spelling but the verdict the help allowance
   RESTS on — `expected string value` at 0.36.0:

   ```
   gog gmail send --to x@y --subject --help
   ```

   `isHelpInvocation` accepts that shape, so `refuse` returns null with no
   group check and nothing is minted. If a bump ever made kong take `--help`
   there as a literal subject, a `gmail send` would run unrefused. Nothing
   else on this list would catch it, which is why it is on this list.

4. Re-run the one that proves the gate is load-bearing: appending
   `--readonly=false` to an otherwise-refused `gmail send` must be refused
   by `gogFlags.ts` before it reaches gog. At 0.36.0, without the gate, it
   reached Google.
5. Re-run the scope bound, which the belt depends on. Against the darwin
   binary, with `--enable-commands=gmail,calendar` in front:

   ```
   gmail|mail|email search q     exit 4 — dispatches (aliases count)
   calendar|cal list             exit 4 — dispatches
   drive ls, chat spaces list    exit 2 — refused BEFORE any network
   ```

   And that the bound constrains EXECUTION, not discovery — the shapes that
   test it are the out-of-scope ones. All exit 0 with full output at 0.36.0:
   `--help`, `-h`, `drive --help`, `chat --help`, `drive ls --help`,
   `calendar --help`, `gmail search -h`. Versus `drive ls`, which is
   refused. So an agent can read help for a group it cannot run — the skill
   says so, because usage that prints cleanly otherwise reads as a surface
   that works.

   And that appending a second `--enable-commands` still widens it, which is
   what `RESERVED_EXACT` exists to refuse. The alias list is gog's to
   change, and `GOG_ALIASES` in `gogGroups.ts` mirrors it.
