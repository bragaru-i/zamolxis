---
name: issue-intake
description: Use before starting untracked work, and before creating or materially changing a GitHub issue for Zamolxis. Owns dedupe, issue shape and where plans live; not PRs (shipping-a-change).
---

# Issue intake

**Invariant:** plans live in GitHub issues on `bragaru-i/zamolxis` and in `docs/`, never in Linear. Check facts before asking the owner.

## Process

1. Verify the report in code, Git history, open PRs or production (`node scripts/prod-inspect.mjs`).
2. Search for the same problem under other words: open and recently closed issues, open PRs, `docs/alpha-status.md` gaps.
3. Comment on or update an existing issue when one covers it; create one only when none does. Use the per-command `bragaru-i` token (`shipping-a-change`).
4. Big or foggy requests: write the destination and the open decisions in the issue, and ask the owner one decision at a time before splitting into tasks.

## Shape

- **Title:** the problem or outcome in plain words, 8 words or fewer. No mechanism, no agent jargon.
- **Why:** one or two sentences in the owner's terms.
- **Evidence:** only what reproduces, decides or verifies it.
- **Acceptance:** 3-5 bullets, each an observable result.
- **Later:** related work deliberately left out, so it is not lost.

## Pair with

`plain-writing`, `glossary`.
