---
name: latch-prod-prime
description: Single-shot context loader for the local production Plow Latch install on this Mac. Probes 9 surfaces (app bundle + PID, app settings, device identity, audit log, approvals, relay reachability, client MCP configs, browser runtime, wire log), prints a PASS/FAIL/WARN digest, and writes a primer to a per-run owner-only temp file (path printed in the digest) with the filesystem map and workflow recipes. Use when starting a fresh session against Latch — phrases like "warm up for Latch", "what did latch approve", "where does Latch keep its data", or when debugging "Latch can't read X". Read-only discovery — performs no mutations (no approvals, execs, config changes, or authenticated relay calls) and never prints credential values.
---

# Latch Prod Prime

Warms a fresh Claude session with the layout, paths, and known-good probes for working against `/Applications/Plow Latch.app` (bundle `co.plow.domo-desktop`) and its app-support root `~/Library/Application Support/Plow-Latch/`.

## Run

```bash
bash .claude/skills/latch-prod-prime/prime.sh
```

## What it does

1. Runs 9 probes (each ~100 ms; <3 s total).
2. Prints a PASS/FAIL/WARN table to stdout.
3. Writes a per-run owner-only primer (`mktemp` under `$TMPDIR`; path printed in the digest) — filesystem map + workflow recipes (what did an agent just do, who is allowed what, which agent binds this Mac, keys-only secret handling).

The core probes — Latch.app (running), app settings, device identity, audit log — are required; their failure exits non-zero. The rest (approvals, relay reachability, client configs, browser runtime, wire log) are nice-to-have and surface as `[WARN]` without affecting the exit code. Optional probes degrade to `[WARN]` when jq/curl are missing.

All paths are env-overridable (`LATCH_PRIME_APP_SUPPORT`, `LATCH_PRIME_LATCH_APP`, `LATCH_PRIME_CLIENT_CONFIG_DIR`) so a hermetic smoke run is possible.

## Boundary

`/latch-prod-prime` is **read-only discovery**. It probes local files and process state, makes one unauthenticated relay reachability check (a 401/403/406 proves the relay is up and demanding auth), and writes one owner-only primer under `$TMPDIR`. It performs **no mutations** — no approvals, no execs, no config changes, no authenticated relay calls — and never prints `relayCredential`, `privateKeyBase64`, or any `Authorization` value (presence/length only; deviceId first 8 chars; accountUid last 3 chars).
