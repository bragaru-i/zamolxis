<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Zamolxis engineering rules

Short on purpose: this file is injected into every agent prompt and resent on every
model call. Read a linked document only when your task needs it. Never describe a
planned capability as shipped; the executable repository is the source of truth.

## Commands

- `pnpm check` = lint, boundaries, typechecks (workspaces and Convex), tests, build.
  Run it before every PR. Discover other commands from `package.json` and CI.
- Changes to `packages/runtime-*`, `packages/node-core` or `apps/node` also need the
  real-Codex acceptance when a Codex login is available (fake runtimes do not exercise
  the adapters; a redaction change once broke every real plan while tests passed):
  `ZAMOLXIS_CODEX_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t "runs text intent"`.
- Tests use disposable Git repositories and worktrees and assert the canonical
  checkout's HEAD and status are unchanged. Mocks never prove native, cloud or phone
  end-to-end behavior; report exact commands, results and untested boundaries.

## Conventions

- Work in an isolated worktree from current `origin/main`; small coherent commits with
  issue references; commit instruction changes (this file, docs) separately.
- Git identity for this repository only: `bragaru-i`, email
  `50721739+bragaru-i@users.noreply.github.com`. No AI attribution (no
  `Co-Authored-By` for agents, no "Generated with" lines). Never switch global Git or
  `gh` credentials; publish with a per-command `bragaru-i` token as described in
  `docs/agent-runbook.md` ("Shipping a change"). If no `bragaru-i` credential is
  available, stop and ask; never fall back to another account.
- The owner merges PRs (squash) after CI; agents open PRs and report CI. State the
  merge order for stacked PRs. Never force push main, bypass CODEOWNERS or protections,
  or claim a merge without Git/PR evidence. Preserve human changes; inspect sibling
  work and the sibling `zamolxis-docs` repository before architectural changes.
- Every push to main that passes CI deploys production (Convex, then Vercel). It does
  not update the Node on the owner's computers: a change under `apps/node/` or
  `packages/` needs the Node service restarted there (never the machine; runbook,
  "Updating the Node"). Current status, known
  gaps and next steps live in `docs/alpha-status.md`; update it when a gap opens or
  closes. Procedures and pitfalls live in `docs/agent-runbook.md`.

## Area rules

- **Control plane:** Product -> Repository -> Work Session -> Task -> Workspace ->
  Agent Run -> Runtime. Human ownership comes from authentication; Node identity is
  authorized separately. Product isolation, idempotency, capacity and state
  transitions are enforced server-side; lost or uncertain owned Runs reserve capacity
  until reconciled. Planning needs SHA-bound repository context; plans are validated
  (structure, acyclic dependencies) before dispatch. Supervisor proposes, backend
  authorizes.
- **Trust:** a Builder completion is a candidate, never trust. An independent Verifier
  runs in its own worktree at the exact candidate SHA with the acceptance criteria and
  public failure evidence only (never Builder private reasoning). Evidence and trust
  decisions are SHA-bound and deterministic; only a trusted exact SHA reaches
  integration. Repair is bounded (Alpha: two) and preserves history. Protected-main
  merges stay under human policy. Canonical checkouts are never agent workspaces;
  parallel lanes use separate worktrees with explicit file ownership.
- **Runtime and evidence:** runtime is distinct from model. Use runtime-core adapters,
  native identities, workspace-bound execution, normalized events and conservative
  uncertain ownership. Effective profiles resolve Product -> owner/global -> Alpha
  fallback and are snapshotted on each Run; never hardcode the Supervisor runtime or
  model. Persist actual model, tokens and cost only when the provider reports them.
- **Token usage (#114):** agents resend their whole conversation on every model call.
  Task descriptions name the exact files, functions and sections a task needs; do not
  ask an agent to read this file (already injected), the README or whole status and
  runbook documents. Split large requests into independent tasks.
