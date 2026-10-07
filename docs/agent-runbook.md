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

## Checking the web UI in a browser (preview harness)

The owner uses the app on an iPhone; check phone layouts before shipping UI changes.

```bash
cd apps/web && ZAMOLXIS_PREVIEW=1 pnpm exec next dev -p 3123     # real app, fixture backend
open "http://localhost:3123/?scenario=owner"                     # also: empty, attention, busy
open "http://localhost:3123/?session=s1&run=r1"                  # running Session, Run detail
```

`apps/web/preview/` replaces `convex/react` and `@convex-dev/auth/react` with an in-memory
store (`fixtures.ts` holds the scenarios; mutations such as sending a message animate a
reply). For automated checks install Playwright in a scratch directory
(`npm i playwright && npx playwright install chromium webkit`) and drive the pages with
`devices["iPhone 14 Pro Max"]` (WebKit) and a 1280px Chromium viewport; assert
`document.documentElement.scrollWidth <= clientWidth` on every screen (iOS zooms the whole
layout out when anything overflows horizontally) and that the console stays free of errors.

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

## GitHub access for publishing (per repository, on the Mac)

"Open pull request" resolves each GitHub repository's credential on the publishing Mac
in this order: its own token in the login Keychain (service
`app.zamolxis.github-token`, account `github.com/<owner>/<repo>`), else the GitHub CLI
account chosen for it in setup (config stores only host + login; the credential is read
with `gh auth token --user <login>` for that one publication), else it fails with
`PUBLISH_GITHUB_NOT_CONNECTED`. The global `gh` account and Git credential helpers are
deliberately never used: they belong to whichever account is signed in on the Mac,
which differs per product. Either credential is used only to push the trusted
`zamolxis/*` branch (inline helper reading the child env; never argv) and open the pull
request through the REST API; it is never sent to Convex, logged or given to agents.

Choose a gh account (the account must be signed in with `gh auth login` first): rerun
`pnpm zamolxis setup` → "Add or remove repositories"; each GitHub repository without a
token lists the signed-in accounts, "Add a dedicated token" and "Decide later". A chosen
account is verified for push access; setup stops if it cannot push. The Node picks a
config change up after setup restarts it.

Add or rotate a dedicated token (run in Terminal on that Mac, signed in to GitHub as
the account that should publish); a token always takes precedence over the account:

```bash
cd /Users/Shared/projects/zamolxis
pnpm zamolxis github-token bragaru-i/zamolxis    # or without a name: all GitHub repositories
```

It opens GitHub's prefilled page (name, description, resource owner, 90 days,
Contents + Pull requests: Read and write). Choose "Only select repositories" → the
repository, generate, paste at the hidden prompt. The token is saved only after
`GET /user` and `GET /repos/{owner}/{repo}` confirm push access. The running Node
picks a new token up within about a minute (no restart) and Settings → Computers →
Repositories shows "publishing as <login> (token, expires in N days)" or
"publishing as <login> (gh account)". Remove with
`pnpm zamolxis github-token <owner/repo> --remove` (then revoke it on GitHub); the
repository falls back to its chosen gh account, if any.
Without a terminal (`setup --repair`, scripts) the command only prints statuses.
Agents must never run `github-token` with a real token, read the Keychain item or run
`gh auth token`; tests use `MemoryRepositoryTokenStore`, an injected gh-account reader
and mocked fetch.

On Linux, the equivalent device and repository credentials are atomic 0600 files in
`${XDG_CONFIG_HOME:-~/.config}/zamolxis`; the directory is 0700 and symlinks or
permissive files are refused. The Node runs as the `app.zamolxis.node` systemd user
service; inspect it with `systemctl --user status app.zamolxis.node` and
`journalctl --user -u app.zamolxis.node.service`.

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
- **Token usage (#114):** a Builder resends its whole conversation on every model call,
  so one task that read AGENTS.md, README, alpha-status and the runbook in full cost 2.6M
  processed tokens over 41 calls (97% cached, still counted by the Codex 5-hour window).
  Task descriptions name specific files and sections; AGENTS.md is injected by Codex and
  must not be re-read; long procedures stay in docs read on demand. Run detail and
  Settings → Usage show calls, fresh, cached and output per role, so a run whose cached
  input dwarfs its fresh input is a long conversation, not a bug in the accounting.
  Codex features Zamolxis agents never use are disabled in the Node's Codex home
  (`codex-home.ts`, `CODEX_CONFIG`); a Node restart rewrites that file. Claude Code
  costs about 23,600 tokens of system prompt and tool schemas per model call before any
  conversation (measured 2026-10-07 with a one-word prompt; the Node's lean flags do not
  change it), so the lever is fewer calls: a working sandbox (each approval is a call),
  a Supervisor that names the files (the "File rule" in `supervisor.ts`, so the Builder
  edits on its first call instead of searching), and "Checks only" verification
  (Settings → Agents → Verifier), which skips the reviewer model entirely because trust
  comes from the deterministic checks either way.
- Setup's service reload must wait for launchd to finish unloading (#70).
- **Merged repository id (2026-10-07):** after the duplicate Product was archived, the Linux
  Node crash-looped at start with `LOCATION_ALREADY_REGISTERED`: setup had rewritten the
  repository id in `config.json` while the local SQLite record for the same checkout kept
  the old one. Fixed in `RepositoryRegistry.register` (an id change for an unchanged
  computer, Git directory and remote updates the record). A Node that was started before a
  backend change keeps the old code: `journalctl --user -u app.zamolxis.node.service` showed
  only `HEARTBEAT_FAILED`/`NODE_CONTROL_FAILED` from the moment #115 deployed until it was
  restarted on the current checkout (`systemctl --user restart app.zamolxis.node`).
- **Linux dev machines:** with `kernel.apparmor_restrict_unprivileged_userns = 1`
  (Ubuntu default) Codex's bubblewrap sandbox cannot create user namespaces, every
  file write and command in a Builder fails ("Failed to write file"), and the
  "runs text intent" real-Codex acceptance times out at 240 s. `codex exec` still
  answers read-only prompts and the Supervisor/Orchestrator/models acceptances pass.
  Run the Builder acceptance on macOS (or relax the sysctl as root) before merging
  runtime changes. The same setting breaks Claude Code's sandbox (`bwrap: loopback:
  Failed RTM_NEWADDR: Operation not permitted`): the CLI then runs every command
  unsandboxed, each one becomes a high-risk approval ("Outside the sandbox"), and each
  approval costs a model round trip (2026-10-07: 21 approvals and 26 model calls for a
  two-file change). Fix as root, once: `sudo sysctl -w
  kernel.apparmor_restrict_unprivileged_userns=0` and the same line in
  `/etc/sysctl.d/60-zamolxis-userns.conf`; then `bwrap --ro-bind / / --unshare-all
  --dev /dev true` must exit 0. Restart the Node afterwards.
- **Unpublished candidate (2026-10-07):** a Builder's candidate commit never reached
  GitHub because the Verifier's fresh worktree had no `node_modules`, so `pnpm run
  typecheck` and `pnpm run test` failed, the Repair run changed nothing and the task
  stopped in "needs input". Find such work with `git worktree list` under
  `~/.config/zamolxis/worktrees/workspaces/` and `git rev-list --count origin/main..HEAD`
  per worktree; the Node's `node-state.sqlite` (`event_outbox`, `command_executions`)
  holds the run summaries and check output. Recover by cherry-picking the candidate onto
  `origin/main` in a worktree, running `pnpm check`, and publishing as `bragaru-i`.
  Since the fix the checks install from the lockfile first; a verification that still
  reports "Not run: the dependencies could not be installed" means the lockfile does not
  match the manifest, or the pnpm store lacks a package and the Node had no network.
- GitHub CI sometimes leaves a job queued without a runner until it is cancelled
  after 15 minutes; re-run it before treating it as a failure.
- "Open pull request" never uses the Mac's active `gh` account or global Git
  credentials: each repository publishes with its own token or its chosen gh account
  (see above). Before #96 the active `gh` account (`ion-wellcopy`) made pushes to
  `bragaru-i` repositories fail with `PUBLISH_PUSH_FAILED`. Repositories configured
  before #96 have neither and fail with `PUBLISH_GITHUB_NOT_CONNECTED` until connected.

## Waiting on the owner

See "Next steps" in `docs/alpha-status.md`: iPhone validation, a second Google
account, and the decision whether the workflow graph (#23) is part of Alpha.
