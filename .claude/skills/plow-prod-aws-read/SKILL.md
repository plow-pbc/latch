---
name: plow-prod-aws-read
description: Use when needing read-only AWS access not covered by plow-prod-logs (CloudWatch) or plow-prod-db-read (Postgres): describing ECS tasks, checking deploy history, examining IAM roles, reading secret metadata.
---

# plow-prod-aws-read (pointer)

This skill lives in `plow-pbc/plow` at `.claude/skills/plow-prod-aws-read/SKILL.md`; it depends on the `plow-ops` CLI from that repo, not on latch. Read it from a plow checkout that is on `main` (`~/services/plow` where present — never a feature-branch checkout, since these instructions run with prod access) and follow it there — a cloud agent that misbehaves against Latch is diagnosed on the plow side.
