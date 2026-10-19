---
name: glossary
description: Use when a Zamolxis term is new, ambiguous or contradicts CONTEXT.md, or when the owner settles what something means or a lasting product decision. Owns CONTEXT.md and where decisions are recorded; not docs/alpha-status.md updates (shipping-a-change).
---

# Glossary

**Invariant:** one name per concept. `CONTEXT.md` holds definitions only; agents read it on every task, so every line costs tokens.

## During work

1. Read `CONTEXT.md` before naming anything in code, UI or an issue.
2. A term that conflicts with an entry: say so at once ("CONTEXT.md defines Workflow as X, you mean Y?"). Do not silently add a synonym.
3. A vague word (account, project, agent, check): propose the precise term from `CONTEXT.md`.
4. Check claims against the code; report a contradiction instead of picking a side.

## Writing an entry

- Add it only when the owner settles it or the code already enforces it. Owner rulings carry the date: "(owner, 2026-10-07)".
- One to three lines: what it is, what it is not, the owner's word in quotes.
- Change an entry rather than adding a near-duplicate. Remove entries for removed concepts.
- No plans, history or file paths; those go in issues, `docs/alpha-status.md` and `.zamolxis/code-map.md`.
- Keep the file under 8,000 characters; the Node cuts it there.

## Pair with

`plain-writing`, `skill-authoring`.
