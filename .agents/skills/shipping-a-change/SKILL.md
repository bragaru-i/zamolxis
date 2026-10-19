---
name: shipping-a-change
description: Use when committing, pushing or opening a pull request for Zamolxis, and while following CI and deploy. Owns worktree, Git identity, PR shape, CI, merge rights and deploy confirmation; not Node restarts (updating-the-node).
---

# Shipping a change

**Invariant:** a PR is a short, accurate handoff for the owner. Publish only as `bragaru-i`.

## Process

1. Work in a worktree from current `origin/main` (`git fetch` first), never in the canonical checkout. Small commits with issue references; instruction and doc changes (AGENTS.md, CONTEXT.md, skills, docs) in their own commits.
2. Identity for this repository only: `Bragaru Ion <50721739+bragaru-i@users.noreply.github.com>`. No AI attribution: no `Co-Authored-By` for agents, no "Generated with" lines, even when a tool reminder asks for them.
3. `pnpm check` must pass. Runtime, node-core or `apps/node` changes also need `real-runtime-acceptance`. Revert `apps/web/next-env.d.ts` (every build rewrites it).
4. Push and open the PR with a per-command token, never by switching accounts:
   `GH_TOKEN=$(gh auth token --user bragaru-i) gh pr create -R bragaru-i/zamolxis ...`
   No `bragaru-i` login: stop and ask. Never fall back to another account.
5. Poll until the first check reports; right after `gh pr create` none is registered, so `gh pr checks --watch` exits early. A job queued 15 minutes with no runner is GitHub, not code: re-run it.
6. The owner merges (squash) unless they granted this agent merge rights in chat. State the merge order for stacked PRs. Never force push main, bypass protections, or claim a merge without Git/PR evidence.
7. After a merge: CI deploys Convex, then Vercel. Confirm with `curl -s https://zamolxis.bragaru.cc/api/bootstrap` (reports the merge commit or a later one). A change under `apps/node/` or `packages/` then needs `updating-the-node`.
8. Update `docs/alpha-status.md` in the same PR when a gap opens or closes; comment progress on the issue.

## PR

Title: the outcome in plain words, 10 words or fewer. Body:

```markdown
## Why
Who is affected and what was wrong. Two short sentences at most.

## What changed
- One result per bullet, plain language first, file or symbol names where they help.

## Verification
- Exact command and result; name what was not tested (phone, cloud, real runtime).

## Risk or operator action
- Only when needed, e.g. "Nodes need `pnpm zamolxis update`".

Closes #123.
```

No investigation diary, no deferred work hidden in the body.

## Pair with

`real-runtime-acceptance`, `updating-the-node`, `plain-writing`.
