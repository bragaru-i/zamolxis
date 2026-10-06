# Agent runbook

How agents ship and operate Zamolxis day to day. Read `AGENTS.md` (rules) and
`docs/alpha-status.md` (what works, gaps, next steps) first; this file is the
procedure. Keep it current when a procedure changes.

## Merge rights

By default the owner merges (AGENTS.md). The owner may grant an agent temporary
merge rights in chat; a grant applies to that agent only. If you have no explicit
grant, open PRs, report CI and state the merge order.

## Shipping a change

1. Work in a worktree from current `origin/main`; small commits with issue
   references; commit email `50721739+bragaru-i@users.noreply.github.com`; no AI
   attribution. `apps/web/next-env.d.ts` is rewritten by every build — revert it,
   never commit it.
2. `pnpm check` must pass. For changes to `packages/runtime-*`, `packages/node-core`
   or `apps/node` also run the real-Codex acceptance (below), and the real-Claude
   acceptance for `packages/runtime-claude` or its Node wiring. Parallel lanes that
   touched the same files must be re-checked after rebasing onto each other.
3. Push and open the PR as `bragaru-i` with the per-command token (AGENTS.md).
4. Wait for CI to finish. Right after `gh pr create` the checks may not be
   registered yet — poll until the first check reports pass/fail rather than using
   `gh pr checks --watch` immediately.
5. Merge (squash) only with merge rights. Every push to main that passes CI runs
   "Deploy production" (Convex, then Vercel). Runs triggered by `workflow_run` are
   named after the commit they deploy; a run for a superseded commit skips its steps.
6. Confirm the live commit: `curl -s https://zamolxis.bragaru.cc/api/bootstrap`
   must report the merge commit (or a later one that contains it).
7. If the change affects the Node (runtime, node-core, apps/node, or Node-facing
   Convex functions), update the Mac Node — see below. Backend first, Node second:
   a newer Node against an older backend can stall its outbox.
8. Record the change in `docs/alpha-status.md` in the same PR when it closes or
   opens a gap, and comment progress on the related GitHub issue.

## Updating the Node on the owner's Mac

```bash
cd /Users/Shared/projects/zamolxis
node scripts/prod-inspect.mjs data commands 5 type,status   # nothing pending/claimed/acknowledged?
git checkout -- convex/_generated/api.ts                     # see "Pitfalls"
git fetch origin main && git merge --ff-only origin/main     # not `git pull` (see "Pitfalls")
pnpm install --frozen-lockfile
launchctl kickstart -k gui/$(id -u)/app.zamolxis.node
```

Then check `launchctl print gui/$(id -u)/app.zamolxis.node` shows `state = running`,
`node scripts/prod-inspect.mjs data workstations 1 name,status,lastHeartbeatAt`
shows a heartbeat a few seconds old, and `node-error.log` does not keep growing for a
minute. A few `NODE_CONTROL_FAILED` / `HEARTBEAT_FAILED` /
`NODE_RECONCILIATION_OR_DELIVERY_REQUIRED` lines at the moment of a restart or boot
are expected; lines that keep appearing are not. Runs in flight resume after a
restart (Codex `thread/resume`), but avoid restarting during active work anyway.
`pnpm zamolxis setup --repair` is the non-interactive health check and repair.

## Inspecting production safely

`node scripts/prod-inspect.mjs data <table> [limit] [fields]` prints recent rows
(timestamps as ages, emails masked); `node scripts/prod-inspect.mjs logs [history]
[seconds]` prints recent function logs. Both read the deploy key from
`~/Library/Application Support/Zamolxis/prod-setup` (or `ZAMOLXIS_PROD_SETUP_DIR`) and
never print it. Never print or commit the contents of that directory. Phone
debugging: if the phone makes no `profiles:viewer` / `auth:signIn` calls in the logs,
the client never connected (see the phone sign-in note in `docs/alpha-status.md`).

## Real-Codex acceptance (uses the local Codex login, disposable repositories)

```bash
ZAMOLXIS_CODEX_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t "runs text intent"          # plan → build → verify → trust
ZAMOLXIS_CODEX_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t "real Codex Supervisor"     # answer, stop
ZAMOLXIS_CODEX_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t "real Codex Orchestrator"   # top-level reply, no repository
ZAMOLXIS_AUTHENTICATED_ACCEPTANCE=1 pnpm exec vitest run tests/approvals-steering.test.ts -t "real Codex approval" # reject, approve
ZAMOLXIS_CODEX_RESTART_ACCEPTANCE=1 pnpm exec vitest run tests/restart-recovery.test.ts -t "real Codex"          # resume after kill
```

## Real-Claude acceptance (uses the owner's signed-in `claude` CLI, disposable repositories)

Runs the installed `claude` with the owner's normal login and config (nothing is copied
into a temporary profile; API key variables are stripped), on `claude-haiku-4-5` with
minimal prompts. Keep usage modest: run it when `packages/runtime-claude` or its Node
wiring changes, not in loops. Required before merging changes to
`packages/runtime-claude`.

```bash
ZAMOLXIS_CLAUDE_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t "Claude"                     # all seven below (~2 min)
ZAMOLXIS_CLAUDE_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t "runs text intent with real Claude"  # plan → build → verify → trust
ZAMOLXIS_CLAUDE_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t "real Claude Orchestrator"   # top-level reply, no repository
ZAMOLXIS_CLAUDE_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t "real Claude permission"     # held approval, restart resume, stop
ZAMOLXIS_CLAUDE_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t "real Claude Verifier"       # read-only even when told to write
```

The other Claude tests: Supervisor question (no runs), Builder edit with usage, model
catalog. `claude auth status` shows whether the CLI is signed in (it prints no tokens).

`--testTimeout 1500000` helps on slow runs. When one fails, log the real outcome
(e.g. the Supervisor's decision and reply) before changing code — the parser's safe
fallback ("answer") can hide the real cause.

## Parallel lanes

Split work into lanes with explicit file ownership, one worktree each, all coding
against a written contract. When lanes are integrated:
- Rebase each lane onto current main and resolve conflicts by intent, not by side.
- `convex/_generated/api.ts` is maintained by hand in this repo: every new Convex
  module must be registered there; expect trivial conflicts.
- When two lanes append to the same file (e.g. `packages/ui/src/styles.css`),
  rebuild the file from the base plus each lane's block rather than trusting the
  conflict hunks — a conflict split one rule and broke the CSS once.
- Run `pnpm check` and the relevant real-Codex acceptance on the combined result.

## Pitfalls and incidents

- **Redaction incident (#73 → #74):** redacting the Codex final reply turned the
  Supervisor plan's JSON `key` fields into `***`, so every real plan was rejected for
  about 40 minutes while all fake-runtime tests passed. The Supervisor reply is now
  parsed first and redacted per field. Origin of the real-Codex rule in AGENTS.md.
- **Dispatch limit (#82):** dispatch used to read every workspace and run ever created
  on a Mac and fail past 1000. Queries over ever-growing tables must filter by live
  status or be bounded to recent rows.
- `git pull` in the canonical checkout can fail with "Cannot fast-forward to multiple
  branches" when another command fetched concurrently; use `git fetch origin main &&
  git merge --ff-only origin/main`.
- A manual `convex deploy` from the canonical checkout regenerates
  `convex/_generated/api.ts`; reset it before updating the checkout.
- `/tmp` is cleared on reboot; keep helpers in the repo, not in `/tmp`.
- Setup's service reload must wait for launchd to finish unloading (#70).
- GitHub CI sometimes leaves a job queued without a runner until it is cancelled
  after 15 minutes; re-run it before treating it as a failure.
- The `gh` account active on the Mac opens PRs from the Node's "Open pull request";
  the owner set it to `bragaru-i`.

## Waiting on the owner

See "Next steps" in `docs/alpha-status.md`: iPhone validation, a second Google
account, and the decision whether the workflow graph (#23) is part of Alpha.
