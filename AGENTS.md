<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Zamolxis engineering workflow

The executable repository is the behavioral source of truth. Inspect sibling
`zamolxis-docs` before architectural changes; synchronize stale references and
README with implemented behavior. Never describe a planned capability as shipped.

## Git and integration

Inspect status, current remote main, branch ancestry, existing worktrees, PRs,
reviews and CI before editing. Preserve human changes. Work in an isolated
worktree. Bring divergent feature stacks deliberately onto a clean branch from
current main; inspect the entire resulting diff. Use small coherent commits with
issue references; commit instruction changes separately. Never force push main,
bypass CODEOWNERS/protections, or claim a merge without Git/PR evidence.

For Zamolxis and zamolxis-docs, use GitHub account `bragaru-i` for publishing
branches and PRs, and commit email `50721739+bragaru-i@users.noreply.github.com`.
Verify attribution before publishing. Configure identity only in these repositories;
never switch global Git/CLI credentials used by unrelated products.

Commits and PRs carry no AI attribution: no `Co-Authored-By` trailers for agents and
no "Generated with …" lines. The global `gh` login on the owner's Mac may be a
different account (`ion-wellcopy`); never publish as it. Use the `bragaru-i` token
per command instead of switching accounts, e.g.
`GH_TOKEN=$(gh auth token --user bragaru-i) gh pr create …` and
`git -c credential.helper= -c 'credential.helper=!f(){ echo username=bragaru-i; echo "password=$GH_TOKEN"; }; f' push …`.
If no `bragaru-i` credential is available, stop and ask; do not fall back.

The owner merges PRs (squash) after CI passes; agents open PRs and report CI. When
a stack of PRs shares files or depends on each other, state the merge order. After
merges, verify the combined main with `pnpm check` in a disposable worktree.

## Releases and status

Every push to main that passes CI deploys production automatically: the "Deploy
production" workflow deploys Convex, then the web app on Vercel, and verifies the
live commit (see README "Deploying production"). It does not update the launchd
Node on the owner's Mac; Node changes need `git pull` and a restart there.
`pnpm deploy:prod` remains the manual path. Current Alpha status, known gaps, operational facts and the
next steps live in `docs/alpha-status.md`; read it before planning work and update
it when a gap closes or a new one is found.

## Control plane and trust

Preserve Product -> Repository -> Work Session -> Task -> Workspace -> Agent Run
-> Runtime. Derive human ownership from authentication; authorize Node identity
separately. Enforce Product isolation, idempotency, capacity and state transitions
server-side. Lost or uncertain owned Runs reserve capacity until reconciled.
Obtain SHA-bound repository context before planning; validate structured plans
and acyclic dependencies before dispatch. Supervisor proposes, backend authorizes.

Builder completion produces a candidate, never trust or Session completion.
An independent Verifier uses a separate Run and worktree at the exact candidate
SHA. Transfer acceptance criteria and public failure evidence, never Builder
private reasoning. Persist SHA-bound evidence and deterministic trust decisions.
Only a trusted exact SHA reaches integration. Repair produces a new candidate,
preserves history and is bounded (Alpha: at most two repairs). Integration keeps
protected-main merge under human policy. Canonical checkouts are never agent
workspaces. Parallel implementation lanes require separate worktrees and explicit
file ownership; inspect sibling work before deliberate integration.

## Runtime and evidence

Runtime is distinct from model. Use runtime-core adapters and native identities,
workspace-bound execution, normalized events and conservative uncertain ownership.
Resolve effective enabled profiles Product -> owner/global -> Alpha fallback;
snapshot configuration on each Run. Do not hardcode Supervisor runtime/model.
Persist actual model, tokens and cost only when the provider reports them.

Discover commands from package.json and CI. Run lint, boundaries, typechecks,
unit/integration tests and production build. Test authorization, concurrency,
provenance, replay, DAG, repair limits and trust-aware completion. Use disposable
Git repositories/worktrees for acceptance and assert canonical HEAD/status are
unchanged. Use authenticated native acceptance when available; mocks do not prove
native/cloud/phone E2E. Report exact commands, results and untested boundaries.
