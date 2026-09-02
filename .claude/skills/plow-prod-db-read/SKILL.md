---
name: plow-prod-db-read
description: Use when running read-only SQL against the production Postgres database to investigate data, correlate logs to DB rows, or answer data questions.
---

# plow-prod-db-read (pointer)

This skill lives in `plow-pbc/plow` at `.claude/skills/plow-prod-db-read/SKILL.md`; it depends on the `plow-ops` CLI from that repo, not on latch. Read it from a plow checkout that is on `main` (`~/services/plow` where present — never a feature-branch checkout, since these instructions run with prod access) and follow it there — a cloud agent that misbehaves against Latch is diagnosed on the plow side.
