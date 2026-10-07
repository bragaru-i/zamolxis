# Alpha status and handoff

Status as of 2026-10-07, main through #129. The **private Alpha** is complete: the core
Supervisor -> Builder -> Verifier -> trust -> integration loop and its web/mobile control
plane are shipped and deployed, and the release gate (#107) passed with PR #123, opened
in production through Zamolxis. The owner deferred real-iPhone, second-Google-account and
second-workstation validation past Alpha (#130). This file is the handoff for any agent picking up the work; update it
when a gap closes or a new one is found. Never describe a planned capability as
shipped or a tested implementation as proven in production.

## What works end to end

- **Onboarding (#45):** `pnpm zamolxis setup` checks prerequisites, asks for the app
  address with an explicit protocol choice (HTTPS only), lists repositories as a
  checklist (paths are canonicalized with `realpathSync.native`), pairs through a
  one-time QR code, installs `app.zamolxis.node` through launchd on macOS or user
  systemd on Linux and waits for the heartbeat. Codex is optional during setup; the
  Node advertises only authenticated runtimes that are actually present.
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
  as text and tone; critical needs a second tap). Low/medium command requests may be
  approved once or for the current run when Codex advertises native session approval;
  high/critical requests remain one-time only. Decisions are delivered to the agent
  through `runtime.approval`. Credential/login/attestation requests, permission
  requests, user-input questions and all Verifier/Supervisor requests are always
  refused; unanswered requests are rejected after 30 minutes, on stop and before any
  terminal event. Real Codex acceptance (2026-10-06, codex-cli 0.160.0): a held
  `curl` approval was rejected and the turn completed with HEAD unchanged.
  **Toasts (2026-10-07):** every pending request also appears as a toast on whatever
  screen is open (Settings, another chat, Run detail), with the same Approve / Approve
  for run / Reject / Open session actions as the card; the open Session's own cards
  also show their requests as toasts (since 2026-10-07, next to its cards); at most three
  toasts, older ones stay on Home; a dismissed toast stays in the inbox. A "Needs approval ›"
  chip on a run (Session, Working now, Run detail) brings that request's toast back, first
  and highlighted (`showApprovals`). The stack is a manual popover, so it sits above open
  sheets.
  **Approval policy (2026-10-07):** a Builder or Repair profile may say "Allow low risk"
  or "Allow low and medium risk" (Settings → Agents → role → Approvals). The run
  snapshots the policy; `applyApprovalEvent` records a covered command request as
  approved by policy and answers it at once (for the rest of the run when the runtime
  offers that). High and critical requests, file changes, tool confirmations and other
  roles always wait for the owner. This is how Codex's "contains brace with quotes,
  character expansion, obfuscated" requests stop interrupting: they are medium risk when
  they stay in the workspace without network.
  **Run sandbox (2026-10-07):** Builders and Repairs get a private TMPDIR (a writable
  sandbox root, removed with the run's connection), so `python3`, Node and test tools no
  longer fail with "Operation not permitted" and ask to leave the sandbox; the shared temp
  folders, home and network stay blocked. Builder and Supervisor instructions say not to
  request escalation (the Supervisor's requests are always refused, so retries only cost
  tokens). Verified with `codex sandbox` and the real-Codex acceptance; not yet measured
  on a real owner task (prompt count and tokens before/after).
  **Worktree preparation (2026-10-07):** the 10 approval requests the Node recorded for
  the 2.1M-token logo task were all high risk and none was about TMPDIR: `pnpm install`,
  `pnpm check` and local preview servers/browsers. In the offline sandbox every `pnpm`
  command failed: the global pnpm 11 switches to the repository's pinned 10.17.1 and
  verifies its signature against the registry. Before an agent starts, the Node now keeps
  each pinned pnpm under `<state>/tools/pnpm@<version>` (installed once with npm), puts it
  first on the agent's PATH, and installs Builder/Repair dependencies from the lockfile
  (`WorkspaceToolchain`). Verified for real: preparation of a fresh worktree took 3 s and
  `pnpm --version`, typecheck, vitest and lint then pass in the offline sandbox. Still
  asking (by design, high risk): starting a local server or browser, because the sandbox
  blocks listening on localhost (EPERM). Codex runtime only; the Claude runtime does not
  receive the prepared PATH yet.
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
- **Web app (#61):** conversation-first Home with a persistent desktop sidebar and a mobile
  drawer. Identity, **New chat**, computer connectivity, Usage and Settings remain fixed while one
  searchable history region scrolls **Chats** and **Work Sessions**, each grouped by day (Today,
  Yesterday, Previous 7 days, Previous 30 days, Older); open session kept in `?session=<id>`;
  your messages with their planning outcome, task cards with runs (status, activity
  label, token totals), Stop per run and per session, pinned composer, Settings sheet
  (Computers, removal, sign-out), iOS safe areas. Shared tokens and components live in
  `packages/ui`.
- **Release (#62, #64):** every push to main that passes CI deploys Convex and the
  web app automatically; `pnpm deploy:prod` is the manual path.
- **Supervisor and conversation (#66):** ordinary questions, status checks, explanations and
  reviews inside a Session create no Tasks or Agent Runs. A requested plan is shown as a proposal
  with "Open this work"; only that owner action or explicit execution language delegates work to
  Builders.
- **Global Orchestrator conversation:** the home screen has durable owner-level **chats**
  outside Work Sessions. Home opens as a new, empty chat; the first message creates the chat
  (`?chat=<id>`, titled after that message, at most 80 characters). Earlier chats are listed in
  the sidebar and can be reopened, renamed or deleted (deleting hides the chat and closes it to
  new messages; its history and any Work Session it opened are kept). Each chat has its own model
  history; another owner's chat is never readable or continuable. Home and Session conversations
  show exchanges on a chronological rail with relative timestamps.
- **Settings:** a menu of five pages in order of use (Agents, Computers & repositories, Usage,
  Storage, People & devices), each row showing its current state in one line (for example the
  Builder's model, which Mac is online, tokens in the last 7 days). Phones show the menu or one
  page with a back button; wide screens show the menu as a left column next to the page. Agents
  is a compact list of roles; tapping one opens its description and editor. Usage and Settings are
  also at the top of the Home sidebar, and the computer status in the header opens Computers directly.
- **Proof images:** Builder, Repair and Verifier instructions ask the agent to save up to 8
  screenshots or previews (PNG, JPEG, WebP, GIF, SVG, at most 5 MB each) in `.zamolxis-proof`
  at the repository root when the result can be seen. When the run ends the Node moves that
  folder out of the worktree (before the candidate commit and the checks, so it is never
  committed), adds images the candidate added or edited (e.g. a new logo) up to the limit, and
  delivers them through the durable outbox: `proof:uploadUrl` → Convex storage → `proof:record`
  (Node-authenticated for its own run; the stored size and type are checked; duplicates and
  files outside the limits are deleted). Each run row in a Session shows thumbnails; a tap opens
  the image full size. Only the Session owner can list them. Screenshots are uploaded as taken:
  they are not redacted, so an agent that screenshots a terminal could capture a secret.
- **Commit IDs in agent replies:** redaction keeps a 40/64-hex string only when Git confirms it
  is a commit of the run's repository (`knownCommit`), so "Reviewed exact SHA …" is readable
  while other hex strings (e.g. old-style tokens) stay hidden.
- **Session work map:** a Session with tasks shows how its work moves in five plain steps (Plan,
  Build, Check, Fix, Ready), each with its state derived from task phases and runs (for example
  "1 agent writing code · 2 of 3 done", "Not needed so far"), and the agent that did it (the
  latest run's runtime and model, else the effective profile). Collapsed to one summary line on
  phones, a horizontal strip on wide screens. Each Task card uses a phase-specific color and a
  compact Build → Check → Fix → Ready track derived from the same state. Tapping a step explains
  it and offers "Change the ... agent", which saves a profile for that Session's Product (next
  runs only; Integration has no agent in Alpha). Questions and status requests answer from
  control-plane state without
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
- **Products (2026-10-06):** Settings → Computers & repositories lists the owner's Products
  (`products.list`: repositories, session count, and which repository the same remote origin
  already has in an older Product). **Archive duplicate** (`products.archive`) merges each
  repository into its older twin (locations move, Nodes naming the old entry land on the
  survivor, same `mergeRepository` as registration) and archives the Product; refused while a
  Session is active in it (`PRODUCT_IN_USE`), while a location is busy (`LOCATION_BUSY`) or
  when a repository exists in no other Product. Archived Products leave every picker; their
  Sessions stay listed. This is how the two "zamolxis" Products left by the pre-#115 rule are
  tidied without a database edit. The sidebar connection line now counts connected computers.
- **Run on (2026-10-06):** when more than one computer has the repository, the proposal review
  offers which computer runs the Session (`repositories.computers`: online state and agents per
  computer; `supervisor.submit`/`orchestrator.openProposal` take `workstationId`). The chosen
  computer must have the repository and be online with the Builder's runtime, else
  `INVALID_ARGUMENT`/`NODE_OR_RUNTIME_OFFLINE`. Every new Session stores `workstationId`;
  follow-ups stay on it and the Session header says "Runs on …". Sessions from before have no
  computer recorded and keep the old first-online choice per message. Not yet: a per-Product
  default, and choosing in the Session composer when an ended Session starts a new one.
- **Owner-friendly UI:** choices use a styled `Picker` (a popover list on wide screens, a bottom
  drawer on phones) and dialogs are centered on wide screens and drawers with a grab handle on
  phones; a drawer inside a drawer (a Picker in Settings → Agents on a phone) no longer closes
  the outer sheet when an option is chosen or Escape is pressed, which lost the unsaved agent
  editor (fixed 2026-10-06); message link chips wrap, so a long Session title can no longer widen the page on iOS
  (fixed 2026-10-06); an idle Session reads **Idle** (not a yellow "Waiting") and has **Close session**
  (`sessions.close`: only when nothing runs; unfinished Tasks are cancelled; a follow-up reopens
  it); statuses, link labels, the deterministic summary and failure messages use plain language;
  Orchestrator and Supervisor prompts ask for non-technical replies and forbid claiming to
  close/stop anything themselves.
- **Access administration (#67):** Settings → People (admins approve, block,
  restore, promote; blocking revokes all sign-ins) and Settings → Signed-in devices.
  First admin via the internal `admin:bootstrapAdmin` (done on prod for the owner).
- **Agents and usage (#68, #114):** Settings → Agents (effective profile per role, edit
  runtime/model/effort, turn off), Settings → Usage (24h/7d/30d tokens by role and
  model, top sessions) and a Usage row per session. Since #114 every role shows model
  calls, fresh input (input minus cached), cached input and output (with reasoning
  tokens where Codex reports them) next to the processed total, which is what the
  Codex and Claude plan limits count; Run detail and the Supervisor log show the same
  line. Cost shows a provider-reported price or "Subscription" (nothing reports a
  price today). The Codex adapter also records cache-write tokens, reasoning tokens and
  one model call per usage report; the Claude adapter cache-write tokens and distinct
  assistant message ids as calls. All counters are monotonic and survive a Node restart.
- **Lean agent prompts (#114):** the Supervisor prompt asks for task descriptions that
  name specific files and sections (never AGENTS.md, which the runtime injects, nor whole
  status/runbook documents) and for large requests split into independent tasks; the
  Node's Codex home writes a `config.toml` that disables multi-agent, skills, plugins,
  apps, goals, memories, hooks, browser/computer use, image generation, realtime and web
  search for every Zamolxis agent. The real-Codex acceptance runs with that config.
- **Runtime model catalog:** the Node asks Codex app-server for its models (`model/list`,
  hidden excluded) at startup and at most every 30 minutes, and reports them with
  reasoning efforts in the heartbeat; `agentProfiles:models` returns them per runtime for
  the owner's computers. Settings → Agents offers them as a Model picker whose effort choices follow
  the chosen model; until a Mac reports models it falls back to a text field.
- **Claude runtime (#95, on main and the owner's Mac Node):**
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
- **Per-repository GitHub publishing (#98, on main; combines #96's per-repository gh
  account):** "Open pull
  request" resolves the credential per repository in this order: its own GitHub token
  from the Mac's login Keychain (`app.zamolxis.github-token`, account
  `github.com/<owner>/<repo>`), else the gh account chosen for it in setup
  (`gh auth token --user <login>` for that one publication), else
  `PUBLISH_GITHUB_NOT_CONNECTED`; the global Git/`gh` identity is never used. Either
  credential is checked with the REST API (login, push permission, expiry; a gh
  account's credential must still be that login, else `PUBLISH_GITHUB_AUTH_REQUIRED`),
  pushed via an inline credential helper reading the git child's environment
  (system/global Git config ignored) and used for the PR through the REST API (#96's
  `gh pr create` path is gone). Setup offers, per GitHub repository without a token,
  the signed-in gh accounts, a dedicated token (prefilled fine-grained token link,
  hidden input) or "Decide later"; `pnpm zamolxis github-token [owner/repo] [--remove]`
  manages tokens. The Node reports status/source/login/expiry (never a credential) to
  `repositoryLocations.githubAccess`, shown in Settings → Computers → Repositories as
  "publishing as <login> (token, expires in N days)" or "(gh account)". Codex, Claude
  and verification checks run without `GH_TOKEN`/`GITHUB_TOKEN`/enterprise variants.
  Tested with mocked GitHub API, an injected gh-account reader and a local bare remote
  only; no real token, real `gh auth token` or GitHub call has been exercised. Limits:
  `permissions.push` reflects the account's role, so a read-only Contents token fails
  only at push time (`PUBLISH_PUSH_FAILED`); repository hooks see the git environment
  during the push; non-GitHub remotes still push with their own Git credentials; the
  gh-account status check runs `gh auth token` about once a minute per repository.
  Proven in production on 2026-10-06: PR #123 was opened by the owner's "Open pull
  request" from the never-published branch
  `zamolxis/rework-the-shared-composer-into-a-chatgp-48af9ca` at the trusted SHA `48af9ca`
  (single "Zamolxis candidate" commit, no force push) and shown in Zamolxis (#107). #105
  treats a retry whose branch is already at the exact trusted SHA as published and
  recovers its PR even when closed or merged.
- **Run detail (#68):** tapping a run opens result, grouped live activity, changes
  (files, base → head, branch) and verification (evidence, trust decision, repairs).
- **Setup repair (#69):** rerunning setup offers Check and repair, repositories,
  pairing again; `--repair` is non-interactive; the device credential lives in the
  login Keychain (migrated on the owner's Mac on 2026-10-06).

- **Computers, not Macs (2026-10-06):** since #113 a Linux computer can run the Node, so the
  app, setup and onboarding say "computer" wherever they used to say "Mac" (Settings →
  Computers & repositories, "No computer paired yet", "Name this computer"). The Node reports
  `process.platform`/`process.arch` in its heartbeat and the computer card shows macOS, Linux or
  Windows next to the name. "Mac" remains only where a signed-in browser really is one
  (People & devices) and in this documentation when it means the owner's actual Mac.
- **One repository, one Product (2026-10-06):** a repository registered from two computers is
  one repository and one Product however its origin remote is written (https or ssh, with or
  without `.git`, any letter case on GitHub); entries are matched by `repositoryRemoteKey` and
  the oldest wins. Entries created before this rule are merged on the next
  `pnpm zamolxis setup` or `setup --repair` from either computer: locations move to the
  survivor, the merged entry points at it (a Node still naming it lands on the survivor) and
  its Product is archived when it has no Work Session. A duplicate with running work is left
  alone until that work finishes. Covered by `tests/repository-identity.test.ts`; not yet
  exercised against production data (the owner's two entries for `zamolxis` merge on the next
  setup run).
- **Runtime defaults (2026-10-06):** roles without an enabled profile no longer default to a
  hardcoded Codex. `agentProfiles.defaultRuntime` picks Codex when one of the owner's
  computers offers it, else what they offer (online computers decide while there are any), and
  Settings → Agents, the Settings menu and the Session work map show that default. **Agent for
  every role** in Settings → Agents switches all six roles of the scope (All products or one
  Product) to Codex or Claude at once (`agentProfiles.setRuntimeForAllRoles`: enabled profiles
  change runtime and lose their runtime-specific model and effort, a disabled one is turned on,
  missing ones are created; names, instructions and limits stay). The computer card lists every
  available runtime ("Claude Code and Codex ready").

## Preview harness

`ZAMOLXIS_PREVIEW=1 pnpm --filter @zamolxis/web dev` runs the real web app against in-memory
fixtures (`apps/web/preview/`, scenarios `owner`, `empty`, `attention`, `busy` via `?scenario=`)
with no sign-in or deployment, so UI changes can be checked in a browser or driven by Playwright
on phone and laptop viewports before shipping (see `docs/agent-runbook.md`). It is dev-only: the
module aliases exist only when the variable is set.

## Remaining Alpha validation and known limits

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
   `orchestratorMessages` and `orchestratorMessageLinks` persist the owner-level chats (one row
   per chat; `orchestrator.submit` without `conversationId` starts a new one), their routing
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
   the agent reports its result). Codex-native approval for the current run is wired for
   low/medium commands and covered by controlled protocol and control-plane tests.
   File-change approvals, MCP elicitations, live
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
   approval, sandbox or capacity behaviour. Missing: any cost data source (Codex and
   Claude report tokens only, so the UI says "Subscription"); the share of the Codex
   5-hour and weekly limits a Session used (Codex reports `rate_limits` per account,
   not per thread, so attributing it to a Session needs a design). Measured for #114
   (2026-10-06, same one-line prompt, same directory, `codex exec` with a home holding
   only the login versus the Node's lean `config.toml`): input per model call fell from
   14,303 to 7,502 tokens; the multi-agent developer blocks disappeared and the skills
   block shrank from 4,183 to 1,755 characters. The Builder-level before/after on a
   logo-redesign-sized Session still has to be taken on the Mac: on the Linux dev
   machine AppArmor blocks unprivileged user namespaces, so Codex's bubblewrap sandbox
   cannot write files and the "runs text intent" acceptance times out on main and on
   the branch alike (the read-only Supervisor, Orchestrator and model-catalog
   acceptances pass there with the lean config). Recommended but not enforced: a
   smaller model or low effort for the Verifier and Supervisor profiles.
   **Checks-only verification (2026-10-07):** a Verifier profile may say "Checks only"
   (Settings → Agents → Verifier → Verification). The run is queued with `checksOnly`,
   the Node starts no runtime session, reports `run.started`/`run.completed` itself
   (`checks:<run>:1..2`), runs the repository checks on the candidate and delivers the
   evidence; trust is decided exactly as before. Run detail titles the run "Verifier run
   (checks only)" and shows no tokens. Measured need: on 2026-10-07 the reviewer model of
   one Verifier run cost 510k processed tokens and 18 calls while trust came from the
   checks alone. The Supervisor prompt also carries a file rule: every delegated task
   names, as repository paths, the files to change and to read first, or is not ready
   (ask/propose); Builder and Repair instructions tell the agent to start from those
   files and search only when they are not enough.
5. **Identity (#47), shipped.** Signed-in devices show a self-reported label
   ("Safari on iPhone"); a minimal service worker makes the app installable with an
   offline page (no caching of app data or API responses); a second-account isolation
   test covers every user-facing query/mutation (convex-test identities). Missing:
   validation with two real Google accounts on the deployed app and iPhone home-screen
   / offline checks (owner-deferred, #130).
6. **Onboarding (#45), shipped.** Rename a computer (Settings or setup), remove a
   repository from a Mac (refused while busy; sticky across Node restarts; re-granted
   from setup's repository list), "Pair again" revokes the previous entry when its
   credential is still valid, setup waits for a heartbeat from the new Node instance,
   and the sessions screen shows a "Get started" checklist derived from real backend
   state (`onboarding.progress`) until the first session. Limits: a missing Codex login
   usually shows as "no heartbeat"; QR scanning before approval is not tracked. The
   real-iPhone camera and home-screen check is owner-deferred (#130).
7. **Integration, shipped for single tasks.** On main (#96), setup selects and
   verifies a publishing gh account per GitHub repository and the Node supplies that
   account's saved credential only to the matching push and PR command without
   changing global `gh` state; PR #98 adds a per-repository token that takes
   precedence (see above). On the owner's explicit "Open pull request", the Node pushes
   the trusted integration commit as `zamolxis/<task>-<sha7>` (no force, hooks
   respected, never the default branch) and opens a PR through the REST API, failing
   with `PUBLISH_GITHUB_NOT_CONNECTED` when the repository has neither credential).
   Nothing merges automatically. Missing: changing/reconnecting the account from web
   Settings and combining several task branches into one PR; base
   branch comes from the checkout's branch when the remote default is unknown.
   Worktree retention: an hourly sweep removes eligible managed worktrees (default 3
   days, 1–30 per owner; planning worktrees after 1 day; unpublished trusted work is
   kept indefinitely), prunes Git metadata and deletes only `zam/...` branches at the
   expected SHA; Settings → Storage shows counts and "Clean up now".
   Verifier worktrees (2026-10-07): the Node's deterministic checks first install the
   repository's dependencies from its lockfile (`pnpm install --frozen-lockfile
   --prefer-offline` or `npm ci`, 10-minute bound, no GitHub tokens) when scripted
   checks are requested; a failed install marks every script failed without running it.
   Before this, every first verification in this repository failed for the lack of
   `node_modules`, a Repair run found nothing to change, and the task stopped in "needs
   input" with the candidate commit left local (runbook, "Unpublished candidate").
8. **Validation.** Done: a Mac reboot on 2026-10-06 — the launchd Node started at
   login, read its credential from the login Keychain and resumed heartbeats with no
   errors once the network was up (a few `HEARTBEAT_FAILED`/`NODE_CONTROL_FAILED` lines
   right after boot are expected); stop against real Codex (#76). Final current-main
   acceptance passed at exact SHA `85c1f32`: `pnpm check` and all five authenticated
   real-Codex groups (intent loop, Supervisor, Orchestrator, approval reject/approve
   and restart/resume) passed, with canonical HEAD and status unchanged. The only
   non-deferred Alpha gate still required is one successful production PR through
   Zamolxis. The owner has deferred these other validations: real iPhone (keyboard
   with the pinned composer, home-screen and offline modes), deployed Google sign-in
   with a second account, and routing across a second registered workstation. The
   control plane supports multiple workstation records, but production currently
   demonstrates only one real Mac.

- **Failure details (2026-10-07):** every Supervisor, Orchestrator and agent-run failure now
  says who failed, on which runtime and model, when and why (the provider's redacted
  reason): Codex reports `turn.error`, the Node sends a `failure` with `command.failed`,
  Convex stores it on the command, the Home chat message and the run (`agentRuns.failure`),
  and the web shows it under the reply, the run row and Run detail; `pnpm zamolxis watch`
  prints it too. Failures from before this change show only their code.
- **Claude Builders (2026-10-07):** Claude Code asked for every Bash command it cannot
  analyse in advance ("a variable cannot be checked in advance") although sandboxed. Builder
  and Repair settings now allow Bash with `allowUnsandboxedCommands: false`: every command
  runs in the sandbox without a prompt and nothing can leave it (with Bash allowed but
  unsandboxed commands possible, one ran unasked and wrote to home: never ship that
  combination). Checked with claude 2.1.287 (`claude -p`, `permission_denials`): variable
  and loop commands run, home writes and `dangerouslyDisableSandbox` are blocked, network
  is a permission request. Consequence: a Claude agent cannot start a local server or
  browser outside the sandbox; such work fails instead of asking. The Claude process also
  gets the prepared pnpm on PATH, and tokens are reported after every model call.

- **Local model as Orchestrator (2026-10-07):** runtime `local` (`packages/runtime-local`)
  sends the Orchestrator's prompt to an OpenAI-compatible server on the computer's
  loopback (LM Studio :1234, Ollama :11434, mlx_lm.server :8080, or
  `ZAMOLXIS_LOCAL_MODEL_URL`) and returns its reply; no tools, no repository. The Node
  advertises it with its chat models while a server answers; `setup` and `doctor` report
  it. Choose it in Settings → Agents → Orchestrator → Local model. It is Orchestrator-only
  in the adapter, the Node (`TEXT_ONLY_RUNTIMES`), the backend (`runtimeAllowedFor`,
  never the default) and Settings. Verified against the owner's LM Studio
  (qwen/qwen3-coder-30b, MLX 4-bit): the real Orchestrator prompt gave valid answer/ask/
  propose decisions in 0.8-3.2 s; not yet exercised through the deployed backend.

- **Backup agents (2026-10-07):** each role's profile keeps up to two backups
  (`agentProfiles.backups`); `agentChain` + `firstAvailable` pick the first agent of the chain
  the computer can start, in `orchestratorTarget`, `submitText` (Builder availability and the
  Supervisor), `dispatch` and `queueRun` (a requested runtime picks the chain entry on it).
  Runs record `backup`. Settings → Agents shows and edits the chain; run rows and Run detail
  say "backup N". Not yet: switching to a backup when a running agent fails (usage limit,
  provider error); that is the next PR, then workflows per product.

- **Workflows per product (2026-10-07):** `agentWorkflows` (owner, product, name) with
  profiles per role (`agentProfiles.workflowId`); `resolveAgentProfile(..., workflowId)` uses
  workflow → product Default → global. `workflows.create` (empty or `copyFrom` any product's
  Default or workflow), `rename`, `remove` (archive, profiles off, refused with
  `WORKFLOW_IN_USE`), `list`, `listAll`. `workSessions.workflowId` is set when a Session opens
  (`supervisor.submit` / `orchestrator.openProposal` take `workflowId`) and used by planning,
  dispatch and `queueRun`. Settings → Agents has a Workflow picker per product; the review
  sheet offers it next to Run on; the Session header shows it. Sessions never move computers:
  a follow-up of a Session without a stored computer uses its latest workspace's and pins it.
  Owner decision (2026-10-07): no automatic switch to a backup when a running agent fails;
  a failure will offer "Try again with [agent]" on the same computer (not built yet).

- **Workflow presets (2026-10-07):** `workflows.create({ preset })` builds Save tokens,
  Balanced, Max quality, Codex only or Local first from `convex/lib/workflowPresets.ts`: per
  role a chain with model hints matched to models the owner's computers report; agents no
  computer offers are dropped, and a role left empty uses the product's Default. An open
  Session has a Workflow picker (`workflows.setForSession`, next agents only).

- **Per-computer workflow and steady Settings (2026-10-07):** `repositoryLocations.defaultWorkflowId`
  (`workflows.setForLocation`) is the workflow new work on that repository starts with on that
  computer; `submitText` applies it when no workflow was chosen (`defaultWorkflow` asks for
  the Default explicitly). Settings → Computers shows it per repository; the review sheet
  pre-selects the chosen computer's. The wide Settings sheet has a fixed height, so switching
  pages no longer resizes and re-centres it (it moved about 100 px before).

- **Settings rework: global workflows, My agents (2026-10-07):** workflows now belong to the
  owner, not a product (`agentWorkflows.productId` optional; `workflows.list` takes no args).
  Each computer picks one (`workstations.defaultWorkflowId`, `workflows.setForComputer`); a
  project may override it on one computer (`repositoryLocations.defaultWorkflowId`). Order
  when work starts: chosen → project on that computer → computer → Default.
  `agentDefinitions` ("My agents", `convex/agents.ts`) are named chains of 1–3 models;
  `agents.assign` copies one into a job's profile (`agentProfiles.agentId`), `unassign` turns
  a workflow's job back to the Default, editing an agent updates every job using it, and a
  hand edit of a job's models unlinks it. Settings menu: Workflows · My agents · Computers &
  projects (with "What runs here": the first model of each job's chain that computer has,
  marked when it is a backup) · Usage · Storage · People & devices. On a laptop the menu and
  the page scroll separately and Sign out stays pinned. **Gap:** older product-level
  profiles still resolve (Session workflow → product → Default) but Settings no longer
  shows them.

- **Agents get context; the Checker judges the request (2026-10-08, #162, #163):** the
  Node reads the repository's `.zamolxis/code-map.md` (area -> files, bounded, redacted;
  optional) and gives it to the planner, Builder, Repair and reviewing Verifier. A reviewing
  Verifier ends with `{"acceptance":[{point, met: true|false|null, where}]}`; the Node turns
  it into `acceptance` evidence. A point not met is failed evidence and so can only block
  trust (Repair gets the reason); trust still needs the deterministic checks. `null` (cannot
  be judged from the repository) never blocks; instructions about how to work are not
  points (a real Codex run blocked "do not run Git" before that rule). Failed checks keep
  their last output lines in the evidence, so Repair sees the real error. Builders are told
  which package scripts the Verifier will run. **Gap:** "Checks only" workflows still skip
  the review; the owner's "Mac > New Local" uses it.

- **Codex + local model (2026-10-07):** runtime `codex-local` is a second `CodexRuntime`
  (`local: { id, modelProvider, models }`) whose threads use Codex's built-in `lmstudio` /
  `ollama` provider. Reading roles only (`READ_ONLY_RUNTIMES`; adapter refuses others).
  Advertised while the server answers and LM Studio reports a loaded context ≥ 32,768
  (`/api/v0/models`); at 8,192 Codex fails with "tokens to keep … greater than the context
  length". Real check: as Supervisor in a repository copy, 10 calls, 167k local tokens, 58 s,
  correct file found. Claude Code + local model was tried (LM Studio answers `/v1/messages`)
  and rejected: the same question was still running after 10 minutes.
  **Fixed:** the daemon's Codex `connect`/`launch` dropped the per-run env, so #132's TMPDIR
  and #133's prepared PATH never reached real Codex agents until this change.

## Next steps, in order

1. For #114, re-run a logo-redesign-sized task and compare the Builder's processed
   tokens and calls (now visible in Run detail) with the 2.6M / 41 baseline.
2. Owner-deferred validation (#130): real iPhone/PWA/offline behavior, a second Google
   account and a second workstation.
3. External ticket links (GitHub/Linear) need a connector first and are not part of
   the implemented Alpha candidate.

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
