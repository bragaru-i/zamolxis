# Zamolxis

Zamolxis is a local-first control plane for autonomous coding work. Convex stores
intent, ownership, Tasks, commands, Runs and trust evidence. The Mac Node makes
outbound connections and executes native runtimes inside managed Git worktrees.
The mobile web app controls and observes Convex; it never connects to the Mac.
Repositories and native credentials remain local.

```text
Product -> Repository -> Work Session -> Task -> Workspace -> Agent Run -> Runtime

Owner -> Orchestrator conversation -> answer / linked Work Session

Text intent -> repository context -> validated plan / DAG
  -> up to 3 Builders -> candidate Git SHA
  -> 1 independent Verifier -> evidence -> deterministic Trust
  -> PASS: integration branch prepared -> Session completed
  -> FAIL: Repair -> new SHA -> verification again (at most 2 repairs)
```

## Alpha behavior

The text Supervisor validates Product/Repository ownership and explicit Session
reuse before requesting a separate planning worktree. The Node discovers
repository instructions, skills and package conventions at a concrete SHA and
context digest **before** producing a plan. Backend validation bounds plan size,
requires unique task keys and topologically ordered dependencies, and rejects
arbitrary shell commands in check specifications. Each message runs a read-only
Supervisor agent on the Node (runtime/model from the Supervisor profile). It decides
to **answer** in chat (no tasks), **propose** a task breakdown without opening work,
**delegate** self-contained tasks only when the user explicitly asks to execute, or
**ask** a clarifying question. A proposal remains a conversation artifact until its
owner selects "Open this work". Output that is not a valid decision is shown as an
answer and never starts Builders; legacy `plan` output is downgraded to a proposal.
A message that is itself a structured text plan is explicit delegation and skips the
Supervisor. The Supervisor proposes; the backend validates and authorizes every
transition, and an LLM never authorizes commands or trust.

Ready independent Tasks dispatch concurrently, subject to transactional Node and
profile capacity. Downstream worktrees inherit trusted prerequisite commits;
multiple prerequisite branches are merged in that worktree before execution.
Conflicts preserve the workspace and require human input. Builder and Repair
edits are captured as local candidate commits after terminal runtime success.
A Builder saying “done” does not complete its Task or Session.

Each candidate receives a separate Verifier Run and worktree at its exact SHA.
Verifiers are read-only (Codex: read-only sandbox; Claude: read-only tools with
every other permission denied) and receive acceptance criteria and
repository context, without Builder private reasoning. The Node then executes
repository-owned package scripts in the verification worktree. Evidence records
contain the command outcome, modality, verifier identity and exact subject SHA.
Git whitespace checks establish static evidence; executable test/acceptance/e2e
scripts establish test or behavioral evidence. An absent check is a failure,
never a fabricated pass. Check failures, missing evidence, dirty workspaces or
SHA changes deny trust. Required modalities come from each validated Task policy;
Alpha automatically executes static, test and behavioral checks. The existing
manual evidence API also represents visual, interaction, mutation and security.

Trust failure creates an isolated Repair workspace based on the failed candidate,
passes public failure evidence, and preserves previous Runs/evidence/decisions.
Repair uses a distinct role/profile and must produce a new candidate SHA. Two
repairs are the maximum. Exhaustion or unchanged repair enters `needs_input` with
a reason. Lost native ownership is preserved for reconciliation.

Trust PASS provisions a dedicated integration workspace/branch at the trusted
SHA. Exact SHA, clean Git state, trust decision and branch identity are checked
again before recording a Git artifact and completing the Task. Session completion
requires every required Task to cross this boundary and no active Runs. Alpha
**prepares local integration branches**; it does not push them on its own,
combine independent output branches into one release, or merge protected main.
Use a final Task depending on independent branches when a combined verified
result is needed. Branch protections and CODEOWNERS are never bypassed.

**Publishing is the owner's explicit action.** A completed Task shows "Open pull
request"; after confirming the branch, base and title, `integration.publish`
(owner-only, idempotent while pending or published) sends `integration.publish`
to the Node holding the integration workspace, only while that workspace is clean
at the exact trusted SHA. The Node re-checks clean state and HEAD, then pushes that
exact commit as `zamolxis/<short-task>-<sha7>` (repository hooks run; no
`--no-verify`, never forced, never the default branch) and opens a pull request
against the default branch (body: task description, verification evidence, trust
decision, "Opened by Zamolxis; merge is a human decision"), or reuses the open one
for that branch on a retry.

**GitHub access is per repository.** At publish time the Node resolves each GitHub
repository's credential in this order, with no other fallback:

1. **Its own token**, if one is stored in the login Keychain of the Mac that publishes
   (service `app.zamolxis.github-token`, account `github.com/<owner>/<repo>` from the
   origin remote): a fine-grained personal access token limited to that repository with
   Contents and Pull requests: Read and write. Add, replace or remove it on that Mac
   with `pnpm zamolxis github-token [owner/repo] [--remove]`: it explains the steps,
   opens GitHub's prefilled token page (repository selection can't be prefilled: choose
   "Only select repositories" and the repository), reads the token with hidden input and
   saves it only once GitHub confirms it can push.
2. **Otherwise the GitHub CLI account chosen for it in setup** (only the host and login
   are stored in Zamolxis config): its saved credential is read with
   `gh auth token --hostname <host> --user <login>` for that one publication, without
   switching the globally active `gh` account.
3. **Otherwise publishing fails** with `PUBLISH_GITHUB_NOT_CONNECTED` and asks the owner
   to connect the repository. The Mac's global Git credential helper and the active
   `gh` account are never used for GitHub.

Whichever source is used, the Node checks it with `GET /user` and
`GET /repos/{owner}/{repo}` (login, `permissions.push`, token expiry; a gh account's
credential must still belong to the chosen login), pushes over HTTPS with an inline
credential helper that reads the credential from the git child's environment (never
argv; system/global Git config and credential helpers are ignored, so a global
`insteadOf` or the Mac's `osxkeychain` account is never used) and opens or reuses the
pull request through the GitHub REST API with the same credential. Refusals:
`PUBLISH_GITHUB_AUTH_REQUIRED` (the chosen gh account is not signed in, now belongs to
another login, or GitHub rejects its credential), `PUBLISH_GITHUB_TOKEN_INVALID`,
`PUBLISH_GITHUB_TOKEN_EXPIRED`, `PUBLISH_GITHUB_NO_PUSH`, `PUBLISH_GITHUB_UNREACHABLE`
and `PUBLISH_GITHUB_TOKEN_UNREADABLE` (Keychain locked). No credential reaches Convex,
the web app, logs or any agent (Codex, Claude and repository checks run with
`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN`
removed). The Node reports only the status (`ok`, `expiring` within 14 days,
`expired`, `invalid`, `no_push`, `missing`, `account_unavailable`, `unreachable`), the
source (`token` or `gh_account`), the GitHub login and the token expiry, at most every
30 minutes per repository and within about a minute of a credential change; Settings →
Computers → Repositories shows it ("GitHub: publishing as bragaru-i (token, expires in 80
days)" or "… (gh account)") with a "Create a token on GitHub" link when it needs one.
Limits: the `permissions.push` check reflects the account's role, so a token whose
Contents permission is read-only passes the check and fails at push time
(`PUBLISH_PUSH_FAILED`); repository hooks run during the push as the owner and can see
the git process environment; non-GitHub remotes are still pushed with the
repository's own Git credentials and get no pull request link. Failures are reported as
codes (`PUBLISH_DIRTY`, `PUBLISH_SHA_MISMATCH`, `PUBLISH_PUSH_FAILED`,
`PUBLISH_PR_FAILED`, `PUBLISH_BASE_UNKNOWN`, `PUBLISH_GITHUB_*`, `PUBLISH_INTERRUPTED`,
…) explained in
plain language, never with remote output; a failed publication can be retried and
does not change the Task or Session outcome. Merging stays a human decision.

**Worktree retention.** Managed worktrees (planning, Builder, Verifier, Repair,
integration) are removed by an hourly backend sweep (`convex/crons.ts`) that sends
`workspace.cleanup` for at most 10 eligible worktrees per online computer; Settings →
Storage shows the count per Mac, what can be removed now and the last cleanup, offers
"Clean up now" (owner-only, same rules and batch) and sets the retention window
(1–30 days, default 3). The rules (`convex/lib/retention.ts`) are deterministic: a
worktree must be `ready`, clean, without an owner Run or any unfinished Run, and
unused for the window (Session activity, last Run, publication). A planning worktree
goes one day after the Supervisor decided (or was stopped). Any other worktree needs
its Session completed, failed, cancelled or waiting with nothing running or queued,
and its Task not verifying, repairing or integrating. Always kept: an integration
worktree whose trusted work was not published (or is being published), a published
one younger than the window, and any worktree holding a trusted, unpublished commit
unless the clean integration worktree holds the same commit. The Node removes a
worktree only with `git worktree remove` (never forced; untracked or modified files
make it refuse with `DIRTY_WORKSPACE_PRESERVED`, recorded as dirty and kept), then
`git worktree prune`. It deletes only that worktree's own `zam/<repository>/<workspace>`
branch, only when the backend named the exact commit (never for trusted, unpublished
work) and the branch still points at it; user branches and published `zamolxis/*`
branches are never touched. Failures are recorded on the worktree with their code and
retried after 6 h and 24 h, at most 3 attempts.

## Agent Profiles and runtimes

Runtime is an execution environment; model is an inference choice. `runtime-core`
provides start, resume, send, stop, inspect and subscribe. Two native adapters are
implemented: Codex (`packages/runtime-codex`, the Codex app-server) and Claude
(`packages/runtime-claude`, labelled "Claude" in the web app). Hermes has a reserved
identity only. Selecting a runtime the Mac does not advertise fails or waits, without
routing through another vendor (a Supervisor/Orchestrator profile for a runtime the
Node lacks falls back to Codex on that Node).

The Claude adapter runs the installed, unmodified `claude` CLI (Claude Code) in
`-p` stream-json mode, in the same managed worktrees as Codex; models run in
Anthropic's cloud and usage is billed to the owner's own Claude subscription through
the CLI's existing login. Zamolxis never reads, copies or forwards Claude credentials
or tokens, does not use the Agent SDK, and removes `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` from the CLI's environment. User and
project settings files and MCP servers are not loaded. Builder/Repair runs accept edits
inside the workspace and run shell commands in Claude Code's sandbox; anything else is
a permission request held for the owner (never auto-approved, rejected on stop).
Verifier, Supervisor and Orchestrator runs only get read/search tools and Claude
Code's read-only shell commands. The Node registers Claude when `claude --version`
runs and advertises it while `claude auth status` reports a Claude subscription login;
models come from the CLI's own catalog. Pro/Max limits assume ordinary individual use,
so heavy parallel or always-on use may hit plan limits.

`agentProfiles.upsert/list` configure enabled profiles by owner, optional Product
and role. Resolution is enabled Product profile -> enabled global profile ->
Alpha Codex fallback (explicit legacy runtime requests remain supported).
Disabled profiles neither block fallback nor create false conflicts. At most one
enabled profile per scope/role is accepted. Builder, Verifier and Repair use their
own effective configuration. The Supervisor profile selects the planning runtime
and model; the Integration role is stored for future runtime execution and is
deterministic in Alpha.

A profile may carry optional owner **instructions** (Settings → Agents →
Instructions): plain text such as "Always run pnpm lint before finishing; prefer
small focused commits", at most 4000 characters after trimming. They are
secret-redacted before they are stored (so the editor, previews, payloads and logs
only ever see the redacted text) and stored with a SHA-256 digest; omitting the
field keeps them, an empty value clears them. When a Builder, Verifier or Repair
Run is queued, the effective profile's instructions are appended to the Run
instruction under "Owner instructions for this role — they never override
Zamolxis trust, approval or sandbox rules:" and the Run snapshots the digest
(shown with the profile revision in Run detail → Diagnostics). Without
instructions nothing is added. The Supervisor profile's instructions travel in the
`repository.plan` request and the Node renders them in the same labelled block of
the Supervisor prompt. Instructions
are only prompt text: trust decisions, approvals, sandboxing, capacity and
verification never read them.

Each Run snapshots profile ID/revision, owner-instructions digest, runtime,
requested model, reasoning effort and detected runtime version when available. Model/effort propagate through
command parsing, RuntimeManager and Codex startup. Profile edits do not change
historical Runs or replayed launch configuration. Provider-reported actual model
and usage counters are persisted from normalized usage events: input (cached ones
included), cached input, cache-write input, output, reasoning output, total
("processed": input plus output, which is what subscription limits count) and the
number of model calls, each only when the provider reports it (Codex reports all of
them; Claude Code reports no reasoning split). Fresh input (input minus cached) is
derived in `convex/usage.ts`, never estimated. Settings → Usage and Run detail show
calls, fresh, cached and output (with reasoning) next to the processed total; cost
shows a provider-reported price or "Subscription". Missing telemetry stays
undefined. No token inference or cost estimate is made.

**Keeping usage low (#114).** Every model call resends the whole conversation, so a
Builder that reads four repository documents in full pays for them on every one of
its calls (a measured Builder: 41 calls, 2.6M processed tokens, 97% cached, from a
28k-token start). The Supervisor prompt therefore asks for task descriptions that
name only the files, functions and sections a task needs, never AGENTS.md (the
runtime injects it) or whole status/runbook documents, and splits large requests
into independent tasks that each start with a fresh conversation. The Node's own
Codex home (`packages/runtime-codex/src/codex-home.ts`) writes a lean `config.toml`
that turns off multi-agent, skills, plugins, apps, goals, memories, hooks, browser,
computer use, image generation, realtime and web search, so Builders and Verifiers
carry none of those prompt blocks. Recommended profiles: a smaller model or low
reasoning effort for the Verifier (it reviews one candidate) and for the Supervisor
(it decides and plans, it does not build), chosen in Settings → Agents.

The server reserves **3 Builder-class slots (Builder + Repair) and 1 Verifier
slot**. Queued and lost/uncertain owned Runs continue reserving capacity until
settlement/reconciliation. Profile concurrency is an additional owner-wide limit,
including across Nodes and profile revisions. UI limits are not authority.

## Identity, pairing and setup

Human login uses **Convex Auth with Google**. Convex stores accounts, sessions and
refresh tokens. Google must report a verified email; no external Auth0/OIDC service
is needed. Google OAuth still requires a Google Cloud OAuth client.

Sign-in does not grant product access. New users enter `pending`. An administrator
approves, blocks or restores people in **Settings → People**; blocking also signs
the person out of every session. The first administrator is created once per
deployment by the operator: approve your own `users` row in the Convex dashboard
(`accessStatus` = `allowed`), then run the internal mutation
`admin:bootstrapAdmin` (`npx convex run admin:bootstrapAdmin '{"email":"you@example.com"}' --prod`
or Dashboard → Functions). There is no public self-grant API and no automatic
first-user administrator. Everyone can list their own signed-in devices and sign
out the others in **Settings → Signed-in devices**. The access screen updates from a
reactive query. Product APIs enforce the same policy server-side; granting access
does not grant ownership of another user's Products or repositories. Blocking an
owner also denies their Nodes' cloud operations and credential refresh; it does
not kill already-running local processes or erase history.

One configured public HTTPS origin (`ZAMOLXIS_APP_URL` on the frontend, the same
value as `SITE_URL` in Convex) binds Google return redirects, bootstrap and QR
links. Host headers and preview URLs do not establish trusted origins. Human
Convex Auth sessions and Node-scoped credentials remain separate. An approved,
authenticated owner approves a five-minute single-use QR; device tokens and
revocation protect outbound Node access. See [Google login and access setup](docs/google-auth-access.md), including the
`google-auth-setup.mjs` helper for separate dev/prod credentials and deployment.

On macOS or Linux with Node >=22, pnpm and Git (Codex or Claude Code is needed only
before running agent work):

```sh
./scripts/setup.sh
# Or, with dependencies installed:
pnpm zamolxis setup
pnpm zamolxis setup --repair   # non-interactive check and repair
pnpm zamolxis doctor
```

The wizard selects repositories and, for each GitHub repository without its own token
on this Mac, offers the accounts signed in to the GitHub CLI, "Add a dedicated token
for this repository" or "Decide later"; a chosen account is verified to push the
repository (setup stops otherwise). Only the host and login are stored in Zamolxis
config; account credentials stay in the GitHub CLI store and tokens in the local
credential store. After pairing, setup reports each repository's GitHub access and offers a
token for those that cannot publish. It validates a managed root outside canonical
checkouts and pairs the Node. macOS uses the login Keychain and launchd; Linux uses
private 0600 files under `${XDG_CONFIG_HOME:-~/.config}/zamolxis` and a user systemd
service. Both use service name `app.zamolxis.node`. Running setup again
offers Check and repair (default: local-store migration of an older plaintext
credential, credential refresh with re-pairing when revoked, service reinstall when
it points elsewhere, heartbeat), Add or remove repositories, Pair again and Exit.
Renaming a Mac and removing a repository from Zamolxis are not supported by the
backend yet; removal only drops the local grant. When Codex is available, native execution uses
a temporary auth-only profile; user plugins/MCP/config are not copied. Setup still
completes without a runtime and reports what must be installed before work can run.
No inbound workstation server is required. See [Alpha setup](docs/alpha-onboarding.md) for
public HTTPS/Google login and device-signing deployment requirements.

Canonical checkouts are never runtime workspaces. Planning, implementation,
verification, repair and integration use separate managed worktrees. The mobile
UI shows task phases, Runs, repair attempts and failure reasons. Its install
manifest supports standalone use; authenticated offline operation is not provided.

## Web app

The web app is phone-first and follows `docs/ui-ux-design-system.md`; shared tokens and
components live in `packages/ui`. It opens with a new, empty top-level Orchestrator chat
outside Work Sessions; earlier chats and Work Sessions are listed in the sidebar grouped by day,
and a chat can be reopened, renamed or deleted. Status questions summarize existing control-plane state and return typed
links without creating work: Sessions, pending approvals, pull requests, Tasks that need you
(with their trust decision) and active Runs. A Run link opens Run detail directly (`?run=<id>`). Explicit execution language creates a Session; explicit
continuation follows a recent linked Session when its Product and repository match. Each routing
decision is persisted. When a Mac is online, the Orchestrator model writes the reply from that
summary (read-only, no repository) and may answer, ask or propose; a proposal starts nothing until
you click **Open this work**. When more than one of your computers has the repository, the
proposal review offers **Run on**: the chosen computer must be online with the Builder's agent,
every new Session records its computer (shown as "Runs on …" in the Session header) and
follow-ups stay there because its worktrees hold the work; without a choice the first online
computer is taken. Without a computer the summary itself is the answer. Settings → Agents
selects the runtime, model, reasoning effort and owner instructions for Orchestrator, Supervisor,
Builder, Verifier, Repair and Integration roles. Global summaries do not link external tickets yet. An open Session is kept in the URL
(`?session=<id>`), so refresh and back navigation keep it. A Session shows
your messages, the planning outcome for each, Task cards with their Runs (status, live
activity label, reported token totals) and a Stop control per active Run and per Session.
The Session composer stays pinned to the bottom; in an ended Session, sending starts a new Session.
Agent requests for permission (a command Codex cannot run in its sandbox, a file change
outside the task) reach you wherever you are: as cards in the Session and on Home, and as
toasts on any other screen, each with Approve, Approve for run, Reject and Open session.
Settings → Agents lets a Builder or Repair profile allow low-risk, or low- and
medium-risk, commands automatically; the backend records those as approved by policy and
answers them at once, while high and critical requests, file changes and tool
confirmations always wait for you. Computer status, removal of a computer and sign-out
are in Settings. The sidebar's
connection line counts connected computers ("Computers connected (2)"). Settings →
Computers & repositories also lists **Products**: one per repository, matched by its remote
origin wherever it is checked out; a product that only repeats repositories of another one
(a leftover from before remotes were compared by identity) has **Archive duplicate**, which
merges its repositories into the older product and archives it, keeping its sessions readable.
It is refused while work runs in it or when a repository exists nowhere else.

Supervisor replies (answers, proposals, delegated work, questions) and each agent's final reply appear in
the conversation, rendered as safe Markdown. Not yet: steering a running agent,
stopping the Supervisor, run activity detail, agent profile and usage screens.

## Structured text plan

Paste a JSON object into the text composer. Dependencies refer only to earlier
keys. Script names refer to existing repository `package.json` scripts; they are
not executable shell text supplied by the plan.

```json
{
  "tasks": [
    { "key": "api", "title": "API", "description": "Implement the API", "dependencies": [], "verificationScripts": ["test:api"], "requiredModalities": ["static", "test"] },
    { "key": "ui", "title": "UI", "description": "Implement the UI", "dependencies": [], "verificationScripts": ["test:ui"], "requiredModalities": ["static", "test"] },
    { "key": "combined", "title": "Combined acceptance", "description": "Validate the combined result", "dependencies": ["api", "ui"], "verificationScripts": ["test:e2e"], "requiredModalities": ["static", "test"] }
  ]
}
```

## Development and evidence

```sh
pnpm install --frozen-lockfile
pnpm check
# Explicit native acceptance using existing local login in a disposable fixture:
ZAMOLXIS_CODEX_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t 'runs text intent'
# Exercise native failure, Repair and a second independent verification:
ZAMOLXIS_CODEX_ACCEPTANCE=1 ZAMOLXIS_CODEX_REPAIR_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t 'runs text intent'
# Real Claude acceptance with the owner's signed-in `claude` CLI (Haiku, small prompts):
ZAMOLXIS_CLAUDE_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t 'Claude'
```

`pnpm check` runs lint, package boundaries, workspace/Convex typechecks, unit and
integration tests, and the production build. Acceptance tests use real Git
worktrees and SQLite/outbox delivery against actual Convex function implementations
in `convex-test`. The fixture runtime test exercises failed trust, Repair and
re-verification; another test proves concurrent Builders and merged dependency
state. The opt-in native test exercises authenticated Codex Builder and independent
Verifier through evidence/trust/integration, asserting canonical HEAD/status remain
unchanged. The native Repair mode deliberately produces a failing first candidate,
then proves a new Repair SHA and workspace, retained failed trust, two independent
Verifier workspaces and final integration. It uses fixture control-plane identities,
not deployed Google/device authentication.

Public phone -> Google/Convex Auth -> pairing -> deployed Convex -> launchd E2E still needs
real-iPhone and second-account validation. Native process resumption after Node restart, the
native approval bridge and explicit pull-request publishing are implemented; richer verification
modalities and combining several independent task branches into one PR remain limited. Repository scripts execute
with local Node authority and must be trusted by the repository owner; Alpha is
not a sandbox for hostile repository code. Node reconciliation preserves ambiguous
leases instead of silently starting a second process.

## Deploying production

**Automatic:** every push to `main` that passes CI triggers the "Deploy production"
workflow (`.github/workflows/deploy.yml`). It skips commits that are no longer the tip
of main, deploys Convex with a production deploy key, builds and deploys the web app
to Vercel production, and waits until `/api/bootstrap` reports the deployed commit.
It can also be started by hand from the Actions tab. It needs, in the repository's
`production` environment:

| Name | Kind | Value |
|---|---|---|
| `CONVEX_DEPLOY_KEY` | secret | production deploy key (`prod:<deployment>\|…`) |
| `VERCEL_TOKEN` | secret | Vercel access token with access to the project's team |
| `VERCEL_ORG_ID` | secret | `orgId` from `.vercel/project.json` |
| `VERCEL_PROJECT_ID` | secret | `projectId` from `.vercel/project.json` |
| `ZAMOLXIS_APP_URL` | variable | public app origin, e.g. `https://zamolxis.example.com` |

The workflow does not touch the Node on your Mac: after a merge that changes
`apps/node` or `packages/*`, run `git pull` in the canonical checkout and restart it
(`pnpm deploy:prod --pull --skip-convex --skip-web`).

**Manual:** from the canonical checkout on `main`:

```bash
pnpm deploy:prod --directory /absolute/private/prod-directory --pull
```

The directory is the private prod directory created by
`scripts/google-auth-setup.mjs prepare --environment prod` (its `config.json` and
`credentials.json` hold the deployment target and deploy key; nothing secret is printed).
The script refuses to run unless local `main` is clean and equal to `origin/main`, runs
`pnpm check`, asks for confirmation, then deploys in dependency order: Convex backend,
web app (`vercel deploy --prod`, stamped with the commit and verified through
`/api/bootstrap`), and finally restarts the launchd Node service when it runs from this
checkout. `--skip-check`, `--skip-convex`, `--skip-web`, `--skip-node` and `--yes` are
available; `--help` lists them. The first web deploy needs `pnpm dlx vercel@62 login`.

## Repository layout and reference material

`apps/web` is Next.js/Convex React; `apps/node` is the Mac executable. Pure rules
live in `packages/domain` and `packages/application`, DTOs in `packages/contracts`,
Git/worktrees in `packages/git`, local state/execution in `packages/node-core`, and
native transports in `packages/runtime-codex` and `packages/runtime-claude`. `convex` owns authenticated
persistence and transactional authorization. Dependency direction points inward;
domain/application do not import native processes or vendor adapters.

[AGENTS.md](AGENTS.md) defines engineering and trust workflows. This executable
repository is the behavioral source of truth. The sibling `zamolxis-docs`
repository contains architectural/reference material; future designs there do not
imply implemented behavior. See [PROJECT.md](PROJECT.md) and the linked issues.
