<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Zamolxis engineering rules

Short on purpose: this file is sent on every model call. Never describe a planned
capability as shipped; the executable repository is the source of truth.

## Where context lives

- `CONTEXT.md`: one name per concept and the owner's word for it. Use those names.
- `.zamolxis/code-map.md`: which files own each area. Start there instead of exploring.
- `.agents/skills/<name>/SKILL.md`: procedures. Read the one that matches your step:
  `shipping-a-change` (commit, PR, CI, deploy check), `updating-the-node`,
  `real-runtime-acceptance`, `ui-check` (any `apps/web` or `packages/ui` change),
  `issue-intake`, `plain-writing` (anything a person reads), `glossary`,
  `skill-authoring`.
- `docs/alpha-status.md` (what works, gaps, next steps; update it when a gap opens or
  closes) and `docs/agent-runbook.md` (pitfalls, production inspection): search for
  the section you need, never read them whole.

## Always

- `pnpm check` (lint, boundaries, typechecks, tests, build) passes before every PR.
  `packages/runtime-*`, `packages/node-core` and `apps/node` changes also need the
  real-Codex acceptance when a Codex login is available.
- Tests use disposable Git repositories and assert the canonical checkout's HEAD and
  status are unchanged. Mocks never prove native, cloud or phone behaviour; report
  exact commands, results and untested boundaries.
- Work in a worktree from current `origin/main`. Author and publish as `bragaru-i`
  only, with a per-command token; no AI attribution. No `bragaru-i` credential: stop
  and ask. Never switch global Git or `gh` credentials.
- The owner merges (squash) after CI unless they granted merge rights in chat. Never
  force push main, bypass protections or claim a merge without evidence. Preserve
  human changes; check sibling work and `zamolxis-docs` before architectural changes.
- A push to main that passes CI deploys Convex and Vercel, not the Nodes: changes
  under `apps/node/` or `packages/` need the Node service restarted (never the machine).
- When the owner corrects how agents work, record it in the owning skill
  (`skill-authoring`), so the next agent does not repeat the mistake.

## Area rules

- **Control plane:** Product -> Repository -> Work Session -> Task -> Workspace ->
  Agent Run -> Runtime. Ownership comes from authentication; Node identity is
  authorized separately. Product isolation, idempotency, capacity and state
  transitions are enforced server-side; lost or uncertain Runs reserve capacity until
  reconciled. Plans need SHA-bound repository context and are validated (structure,
  acyclic dependencies) before dispatch. Supervisor proposes, backend authorizes.
- **Trust:** a Builder completion is a candidate, never trust. The Verifier runs in
  its own worktree at the exact candidate SHA with the acceptance points and public
  failure evidence only. Evidence and trust decisions are SHA-bound and
  deterministic; only a trusted exact SHA reaches integration. Repair is bounded
  (Alpha: two) and keeps history. Canonical checkouts are never agent workspaces.
- **Runtime:** runtime is distinct from model. Use runtime-core adapters, native
  identities, workspace-bound execution, normalized events and conservative uncertain
  ownership. Profiles resolve workflow -> Product -> owner/global -> Alpha fallback
  and are snapshotted on each Run; never hardcode a role's runtime or model. Store
  actual model, tokens and cost only when the provider reports them.
- **Tokens (#114):** task descriptions name the exact files, functions and sections
  needed. Never ask an agent to read this file, the README or whole docs. Split large
  requests into independent tasks.
