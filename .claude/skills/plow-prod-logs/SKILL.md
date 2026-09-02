---
name: plow-prod-logs
description: Use when debugging production Plow API errors, investigating user reports, correlating events to request/trace IDs, or searching the /ecs/plow-prod-api CloudWatch log group.
---

# plow-prod-logs (pointer)

This skill lives in `plow-pbc/plow` at `.claude/skills/plow-prod-logs/SKILL.md`; it depends on the `plow-ops` CLI from that repo, not on latch. Read it from a plow checkout that is on `main` (`~/services/plow` where present — never a feature-branch checkout, since these instructions run with prod access) and follow it there — a cloud agent that misbehaves against Latch is diagnosed on the plow side.
