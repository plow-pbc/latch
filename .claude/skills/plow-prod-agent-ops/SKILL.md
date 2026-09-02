---
name: plow-prod-agent-ops
description: Use when a question names a Plow user by phone, name, or id and asks which cloud-agent container/VM they're on, or when you need a shell or logs on a user's exe.dev agent — "which container is X on", "ssh into X's agent", "check X's gateway logs".
---

# plow-prod-agent-ops (pointer)

This skill lives in `plow-pbc/plow` at `.claude/skills/plow-prod-agent-ops/SKILL.md`; it depends on the `plow-ops` CLI from that repo, not on latch. Read it from a plow checkout (`~/Hacking/plow<N>` in your lane, or `~/services/plow`) and follow it there — a cloud agent that misbehaves against Latch is diagnosed on the plow side.
