---
name: skill-authoring
description: Use when creating, changing, merging or deleting a skill in .agents/skills, or when an owner correction should become a lasting rule. Owns skill size, shape and learning from corrections; not CONTEXT.md entries (glossary).
---

# Skill authoring

**Invariant:** a skill teaches a procedure an agent would otherwise get wrong, in the fewest lines that still work. Every name and description is sent on every model call; bodies load only when used.

## Keep a line only if

removing it causes a wrong action, a missed gate or the wrong skill being picked. Cut history, restated code, soft tips and duplicate examples.

## Shape

- Folder `.agents/skills/<name>/SKILL.md` (`.claude/skills` links here, so Claude and Codex share it). Name: lowercase with hyphens.
- Frontmatter `name` and `description`. The description starts with `Use when...`, names what the skill owns, and excludes the neighbour it could be confused with ("not Node restarts (updating-the-node)").
- Body: invariant, process, gotchas, "Pair with" at most three skills. 80 lines at most.
- One owner per procedure. A fact lives in one place: a skill, `CONTEXT.md`, `docs/agent-runbook.md` or `docs/alpha-status.md`; others link to it.

## Changing a skill

- Default to updating the owner skill; create one only when no skill owns the procedure.
- Net zero: for each line added, delete one at least as weak. Check `wc -l` before and after.
- Re-read the neighbours' descriptions; change yours if an agent could pick the wrong one.
- Delete only after `grep -r <name> .agents AGENTS.md docs` finds no dependants.
- Commit skill changes separately from code.

## Learning from corrections

When the owner corrects an agent, or the same mistake happens twice, or a review catches a missed rule: add the rule to the owner skill (or `AGENTS.md` when it applies to every task). Verify it against the code and the live command first; never copy a command from a transcript unverified. Skip one-off successes and environment accidents.

## Pair with

`glossary`, `plain-writing`.
