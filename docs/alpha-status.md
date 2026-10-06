# Alpha status and handoff

Status as of 2026-10-06, main through #89. Alpha is **not finished**:
issues #45, #47, #48 and #49 are open. This file is the handoff for any agent picking
up the work; update it when a gap closes or a new one is found. Never describe a
planned capability as shipped.

## What works end to end

- **Onboarding (#45):** `pnpm zamolxis setup` checks prerequisites, asks for the app
  address with an explicit protocol choice (HTTPS only), lists repositories as a
  checklist (case-insensitive macOS paths are canonicalized with
  `realpathSync.native`), pairs through a one-time QR code, installs the launchd
  service `app.zamolxis.node` and waits for the heartbeat.
- **Identity (#47):** Google sign-in through Convex Auth, database-controlled access
  (`users.accessStatus`), Node identity separate from human identity and revocable.
- **Execution:** text command → SHA-bound repository context → plan validated by the
  backend → up to 3 parallel Builders and 1 Verifier in separate worktrees →
  deterministic trust → at most 2 repairs → local integration branch. Tested with
  FakeRuntime and manually with Codex (`docs/alpha-validation.md`).
- **Node commands:** `workspace.provision`, `repository.plan`, `runtime.start`,
  `runtime.stop`, `runtime.send`, `runtime.approval` (stop/send/approval are
  delivered while a run streams, via a separate control loop), `workspace.cleanup`,
  `integration.prepare`. Unknown or malformed commands fail individually and no
  longer block the queue (#60).
- **Approvals bridge:** Codex command, file-change and form-only MCP approval
  requests from builder/repair runs are held and shown on the phone (summary, risk
  as text and tone; critical needs a second tap); Approve/Reject is delivered to the
  agent through `runtime.approval`. Credential/login/attestation requests, permission
  requests, user-input questions and all Verifier/Supervisor requests are always
  refused; unanswered requests are rejected after 30 minutes, on stop and before any
  terminal event. Real Codex acceptance (2026-10-06, codex-cli 0.160.0): a held
  `curl` approval was rejected and the turn completed with HEAD unchanged.
- **Activity summaries:** the Codex adapter reports the real command line (wrapper
  removed, exit code or failure reason on completion), MCP `server/tool`, web
  searches and sub-agent labels; agent text, tool output and reasoning are never
  uploaded. Every summary passes `redactSecrets` (runtime-core: secret-named values,
  auth headers, URL credentials, private keys, known token shapes, high-entropy
  strings) and is bounded to 500 chars. Verified with real codex-cli 0.160.0 for
  command execution; other item types by controlled tests.
- **Execution trace (#27):** every Builder, Repair and Verifier run records ordered
  trace steps on the Node (repository discovery, workspace, runtime, candidate
  commit, each verification check with exit code, duration and a redacted output
  tail), delivered through the durable outbox to `traces:append` (Node-authenticated,
  bounded, idempotent; at most 500 steps per trace) and shown as "Trace" in Run
  detail. The backend adds `trust` (eligible or not, evidence counts, reasons),
  `integration` (prepared at SHA, branch) and publish (PR, compare link or failure)
  steps to the candidate's trace (`backend:` step ids, which Nodes cannot write).
  Supervisor steps are recorded per message in `supervisorLogSteps` (see gap 1).
- **Steering:** "Message agent" on an active run steers a streaming Codex turn
  (`turn/steer`) or continues a waiting run to completion with the normal
  completion handling.
- **Web app (#61):** conversation-first Home with a persistent desktop Work Sessions sidebar and
  a mobile sessions drawer; open session kept in `?session=<id>`;
  your messages with their planning outcome, task cards with runs (status, activity
  label, token totals), Stop per run and per session, pinned composer, Settings sheet
  (Macs, removal, sign-out), iOS safe areas. Shared tokens and components live in
  `packages/ui`.
- **Release (#62, #64):** every push to main that passes CI deploys Convex and the
  web app automatically; `pnpm deploy:prod` is the manual path.
- **Supervisor and conversation (#66):** ordinary questions, status checks, explanations and
  reviews inside a Session create no Tasks or Agent Runs. A requested plan is shown as a proposal
  with "Open this work"; only that owner action or explicit execution language delegates work to
  Builders.
- **Global Orchestrator conversation:** the home screen has a durable owner-level conversation
  outside Work Sessions. Questions and status requests answer from control-plane state without
  creating hidden work. Answers persist their route and typed links: Sessions, pending approvals,
  pull requests, Tasks needing the owner with their trust decision, and active Runs (a Run link
  opens Run detail via `?run=`). Every Home message remains conversation: execution language,
  including "continue" and "do it", creates an inert proposal. The owner reviews the full request
  and selected Product/repository in a separate sheet; only **Open Work Session and start
  planning** creates work, idempotently. Role runtimes, models, effort and instructions remain
  selectable in Settings → Agents.
- **Agents at a glance:** Home shows **Working now**: every Builder, Verifier, Repair run and
  in-flight Supervisor turn across Sessions (`runs.listActive`), each with runtime, model, current
  activity, elapsed time, tokens so far and cost when a provider reported one; tapping opens the
  Session or Run detail, Stop stops a run. Session task cards use the same agent rows. Cost is
  still never reported by Codex or Claude (see Usage).
- **Owner-friendly UI:** choices use a styled `Picker` (a popover list on wide screens, a bottom
  drawer on phones) and dialogs are centered on wide screens and drawers with a grab handle on
  phones; message link chips wrap, so a long Session title can no longer widen the page on iOS
  (fixed 2026-10-06); an idle Session reads **Idle** (not a yellow "Waiting") and has **Close session**
  (`sessions.close`: only when nothing runs; unfinished Tasks are cancelled; a follow-up reopens
  it); statuses, link labels, the deterministic summary and failure messages use plain language;
  Orchestrator and Supervisor prompts ask for non-technical replies and forbid claiming to
  close/stop anything themselves.
- **Access administration (#67):** Settings → People (admins approve, block,
  restore, promote; blocking revokes all sign-ins) and Settings → Signed-in devices.
  First admin via the internal `admin:bootstrapAdmin` (done on prod for the owner).
- **Agents and usage (#68):** Settings → Agents (effective profile per role, edit
  runtime/model/effort, turn off), Settings → Usage (24h/7d/30d tokens by role and
  model, top sessions) and a Usage row per session. Cost appears only if a provider
  reports it (nothing does today).
- **Runtime model catalog:** the Node asks Codex app-server for its models (`model/list`,
  hidden excluded) at startup and at most every 30 minutes, and reports them with
  reasoning efforts in the heartbeat; `agentProfiles:models` returns them per runtime for
  the owner's Macs. Settings → Agents offers them as a Model picker whose effort choices follow
  the chosen model; until a Mac reports models it falls back to a text field.
- **Claude runtime (branch `feat/claude-runtime`, not yet on main or the Mac Node):**
  `packages/runtime-claude` drives the installed `claude` CLI (Claude Code) over its
  `-p` stream-json protocol in the same managed worktrees as Codex; it is labelled
  "Claude" in the web app. Auth and billing: the owner's own Claude Code login
  (subscription); Zamolxis never reads, copies or forwards Claude credentials or tokens,
  does not use the Agent SDK, and strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`
  and `ANTHROPIC_BASE_URL` from the CLI's environment. Pro/Max limits assume ordinary
  individual use, so heavy parallel or always-on use may hit plan limits. The Node
  registers it when `claude --version` runs (PATH or `~/.local/bin/claude`) and
  advertises it (`start`, `stop`, `message`, `approval`) while `claude auth status`
  reports a Claude subscription login; models come from the CLI's `initialize`
  catalog (default `claude-opus-5-5`). Read-only roles (Verifier, Supervisor,
  Orchestrator) get only Read/Glob/Grep and Claude Code's read-only shell commands
  (`dontAsk`); Builder/Repair accept edits in the workspace and run sandboxed shell
  commands, everything else is held for the owner. Real acceptance (Haiku,
  2026-10-06): Supervisor question, Orchestrator answer, Builder edit with usage,
  read-only Verifier, a held approval rejected by stop, restart resume with the
  pending approval withdrawn, and the full Supervisor → Builder → Verifier → trust →
  integration loop. Limits: after a restart an unfinished Claude turn is always
  treated as interrupted (the transcript is not read); real Repair and an approved
  real permission request are covered by controlled tests only; cost is not recorded
  (the CLI's cost figure is an estimate, not the subscription's billing).
- **Per-repository GitHub publishing (branch `feat/repo-github-tokens`, not yet on main
  or the Mac Node):** "Open pull request" pushes and opens the pull request with the
  repository's own GitHub token from the Mac's login Keychain
  (`app.zamolxis.github-token`, account `github.com/<owner>/<repo>`), via an inline
  credential helper reading the token from the git child's environment (system/global
  Git config ignored) and the GitHub REST API; the global Git/`gh` identity is never
  used, a missing/invalid/expired/read-only token fails with `PUBLISH_GITHUB_*`.
  `pnpm zamolxis github-token [owner/repo] [--remove]` (also a setup step) guides the
  owner through GitHub's prefilled fine-grained token page and reads the token with
  hidden input. The Node reports status/login/expiry (never the token) to
  `repositoryLocations.githubAccess`, shown in Settings → Macs → Repositories. Codex,
  Claude and verification checks run without `GH_TOKEN`/`GITHUB_TOKEN`/enterprise
  variants. Tested with mocked GitHub API and a local bare remote only; no real token
  or GitHub call has been exercised yet. Limits: `permissions.push` reflects the
  account's role, so a read-only Contents token fails only at push time
  (`PUBLISH_PUSH_FAILED`); repository hooks see the git environment during the push;
  non-GitHub remotes still push with their own Git credentials.
- **Run detail (#68):** tapping a run opens result, grouped live activity, changes
  (files, base → head, branch) and verification (evidence, trust decision, repairs).
- **Setup repair (#69):** rerunning setup offers Check and repair, repositories,
  pairing again; `--repair` is non-interactive; the device credential lives in the
  login Keychain (migrated on the owner's Mac on 2026-10-06).

## Preview harness

`ZAMOLXIS_PREVIEW=1 pnpm --filter @zamolxis/web dev` runs the real web app against in-memory
fixtures (`apps/web/preview/`, scenarios `owner`, `empty`, `attention`, `busy` via `?scenario=`)
with no sign-in or deployment, so UI changes can be checked in a browser or driven by Playwright
on phone and laptop viewports before shipping (see `docs/agent-runbook.md`). It is dev-only: the
module aliases exist only when the variable is set.

## Gaps blocking Alpha

1. **Supervisor (#49), shipped as answer/propose/delegate/ask.** Every message runs a read-only
   Supervisor agent on the Node (`packages/node-core/src/capabilities/supervisor.ts`,
   run id `supervisor:<textCommandId>`, runtime/model from the Supervisor profile with a
   fallback to a registered runtime). It answers questions in chat, plans
   project conversation. It answers questions, proposes self-contained parallel tasks without
   opening them, delegates only on explicit execution intent, or asks a clarifying question;
   unparseable and legacy `plan` output is treated conservatively and never starts Builders.
   A proposal becomes executable only through its owner-only "Open this work" action. While it
   works the message shows
   its live activity, elapsed time and tokens (reported at most every 2 s), and it can
   be stopped until it decides ("Stopped before answering"). Each settled reply has "Show what I did": a
   bounded, redacted log of its steps (discovery, tool calls with files read, notes,
   refused approvals, decision), delivered when it settles (no live log; none if a Node
   restart interrupted it). Real Codex acceptance
   (2026-10-06): a question is answered with no tasks or runs, and a long
   investigation is stopped mid-turn with the repository unchanged. Still missing: it
   is not a backend agent run and its full event stream is not shown;
   `packages/supervisor` is unused. Incident 2026-10-06:
   #73's reply redaction turned plan task keys into `***`, so every real plan was
   rejected for about 40 minutes until #74 (the Supervisor reply is now redacted per
   field after parsing).
2. **Global Orchestrator conversation, shipped with limits.** `orchestratorConversations`,
   `orchestratorMessages` and `orchestratorMessageLinks` persist the owner-level chat, its routing
   decision (new messages use `answer` or `propose`; historical `create`/`continue` values remain)
   and typed navigation. The current backend answers
   architecture questions and deterministic status summaries directly, with typed links, and
   creates no Session/Task/Run for any Home message. Execution-looking text becomes an inert
   proposal; the separate owner confirmation uses the existing SHA-bound Session Supervisor.
   Links cover Sessions, approvals, pull requests, attention Tasks, trust decisions and active Runs
   of the five most recent Sessions in scope; link status is a snapshot from answer time. Current
   limits: no external-ticket links (no connector).
   **Model-backed replies:** with an online Node that has the effective Orchestrator profile's
   runtime (Settings → Agents → Orchestrator; Codex by default), a question is stored with the
   deterministic summary and status `thinking`, and an `orchestrator.answer` command asks the
   model for the reply. The model receives only that summary, its link list and the last 10
   exchanges, and runs read-only in an empty scratch directory (no repository, no workspace lease,
   approvals rejected, stopped after 5 minutes). It may `answer`, `ask` or `propose`; a proposal is
   inert until the owner reviews it and clicks **Open Work Session and start planning**, which
   opens a Session with an explicit request.
   Routing, links and Session creation stay backend-authorized. Without a Node, or when the model
   fails, the deterministic summary is the answer (`answeredBy: "deterministic"`, `modelError`).
   There is no opt-out yet: every question uses tokens when a Node is online. The sidebar's
   search and lifecycle filters currently apply to loaded pages only; server-wide discovery,
   hide/restore, the dedicated attention index, new-session drafts and persistent navigation
   while a Session is open remain unshipped. **In-Session conversation is shipped:** Supervisor replies (Markdown, bounded to 8000),
   builder/verifier final replies (`agentRuns.resultSummary`) and intermediate agent
   notes (`run.message`, redacted, ≤2000 chars, shown in Run detail Activity) are
   shown. Whether a model writes commentary is up to the model.
3. **Steering and approvals, shipped with limits.** Real Codex acceptance covers a
   command approval being rejected (HEAD unchanged) and approved (the command runs and
   the agent reports its result). File-change approvals, MCP elicitations, live
   `turn/steer` and the 30-minute timeout are covered by controlled tests only. A completed Codex turn ends its run, so "send to a waiting run" only
   applies to runtimes that pause. **Restart recovery:** Codex runs resume after a Node
   restart from the persistent `<managedRoot>/codex-home` (`thread/resume`); an
   interrupted turn is continued (at most twice per run), approvals pending at the
   restart are rejected and the agent asks again, an interrupted Supervisor plan fails
   with `SUPERVISOR_INTERRUPTED` and must be resent, and runs that cannot be resumed
   become lost with a reason (the owner can Dismiss them). Real-Codex restart
   acceptance (2026-10-06): a builder killed mid-command resumed and completed. A follow-up message in the composer is a new Supervisor turn in
   the same session. A reopened session is judged only by work planned since it
   reopened (`workSessions.reopenedAt`), so an earlier failed task no longer pulls it
   back to failed.
4. **Profiles and usage (#48), shipped.** Profile name, max concurrency, per-product
   overrides and owner **instructions** (≤4000 chars, secrets redacted on save) are
   editable in Settings → Agents. Instructions are appended to Builder, Verifier and
   Repair prompts and to the Supervisor prompt in a labelled block, recorded on each
   run (digest + revision, shown in Run detail diagnostics), and never change trust,
   approval, sandbox or capacity behaviour. Missing: any cost data source (Codex
   reports tokens only).
5. **Identity (#47), mostly shipped.** Signed-in devices show a self-reported label
   ("Safari on iPhone"); a minimal service worker makes the app installable with an
   offline page (no caching of app data or API responses); a second-account isolation
   test covers every user-facing query/mutation (convex-test identities). Missing:
   validation with two real Google accounts on the deployed app and iPhone home-screen
   / offline checks.
6. **Onboarding (#45), shipped.** Rename a Mac (Settings or setup), remove a
   repository from a Mac (refused while busy; sticky across Node restarts; re-granted
   from setup's repository list), "Pair again" revokes the previous entry when its
   credential is still valid, setup waits for a heartbeat from the new Node instance,
   and the sessions screen shows a "Get started" checklist derived from real backend
   state (`onboarding.progress`) until the first session. Limits: a missing Codex login
   usually shows as "no heartbeat"; QR scanning before approval is not tracked.
7. **Integration, shipped for single tasks.** Setup selects and verifies a publishing
   account per GitHub repository; the Node supplies that account's saved credential
   only to the matching push and PR command without changing global `gh` state. On
   the owner's explicit "Open pull
   request", the Node pushes the trusted integration commit as
   `zamolxis/<task>-<sha7>` (no force, hooks respected, never the default branch) and
   opens a PR with `gh` (or returns a compare link when no account was configured).
   Nothing merges automatically. Missing: changing/reconnecting the account from web
   Settings and combining several task branches into one PR; base
   branch comes from the checkout's branch when the remote default is unknown.
   Worktree retention: an hourly sweep removes eligible managed worktrees (default 3
   days, 1–30 per owner; planning worktrees after 1 day; unpublished trusted work is
   kept indefinitely), prunes Git metadata and deletes only `zam/...` branches at the
   expected SHA; Settings → Storage shows counts and "Clean up now".
8. **Validation.** Done: a Mac reboot on 2026-10-06 — the launchd Node started at
   login, read its credential from the login Keychain and resumed heartbeats with no
   errors once the network was up (a few `HEARTBEAT_FAILED`/`NODE_CONTROL_FAILED` lines
   right after boot are expected); stop against real Codex (#76). Not yet: real iPhone
   (keyboard with the pinned composer, home-screen mode), deployed Google sign-in with
   a second account.

## Next steps, in order

1. External ticket links (GitHub/Linear) need a connector first.
2. Real-device validation: iPhone and a second Google account.

## Operations on the owner's Mac

- Canonical checkout: `/Users/Shared/projects/zamolxis`. The launchd Node runs
  `apps/node/src/daemon.ts` from it; update it with the procedure in
  `docs/agent-runbook.md` (fetch + fast-forward, install, then
  `launchctl kickstart -k gui/$(id -u)/app.zamolxis.node`). Logs:
  `~/Library/Application Support/Zamolxis/node.log` and `node-error.log`.
- Node config: `~/Library/Application Support/Zamolxis/config.json`; managed worktrees
  live under `~/Library/Application Support/Zamolxis/worktrees` and belong to the Node.
- Production: Convex deployment `cheery-fox-709` (eu-west-1), app
  `https://zamolxis.bragaru.cc`. The private prod setup directory (deploy key, Google
  credentials, signing keys) is passed with `--directory` or
  `ZAMOLXIS_PROD_SETUP_DIR`. Never print or commit its contents.
- Merges to main deploy Convex and the web app automatically through the "Deploy
  production" GitHub Actions workflow (after CI passes). Vercel itself is not
  connected to GitHub; the workflow deploys with a Vercel token. The Mac Node is not
  updated by it; see `docs/agent-runbook.md` "Updating the Node" (or
  `pnpm deploy:prod --pull --skip-convex --skip-web`). `pnpm deploy:prod` is the
  manual full release (needs `pnpm dlx vercel@62 login` once).
- The private prod setup directory is at
  `~/Library/Application Support/Zamolxis/prod-setup` (moved out of `/private/tmp`).
- Phone sign-in: with a stale sign-in saved on the device (Convex Auth keys
  `__convexAuth*` in localStorage), the app stayed on "Checking access…" forever and
  made no backend calls, which looked like "cannot log in". Since the startup
  diagnostics change, after 10 s it offers "Reset sign-in on this device"; an inline
  watchdog reports "Zamolxis didn't start" (with the error and user agent) if the app
  bundle never runs, and `app/error.tsx` shows render errors instead of a blank page.
  When debugging phone issues, watch Convex logs for `profiles:viewer` and
  `auth:signIn` calls from the device: their absence means the client never connected.
- CI on GitHub occasionally leaves jobs queued with no runner until they are cancelled
  after 15 minutes; that shows as a failure without any step running. Re-run the job
  before treating it as a code failure.
