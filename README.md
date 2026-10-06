# Zamolxis

Zamolxis is a local-first control plane for autonomous coding work. Convex stores
intent, ownership, Tasks, commands, Runs and trust evidence. The Mac Node makes
outbound connections and executes native runtimes inside managed Git worktrees.
The mobile web app controls and observes Convex; it never connects to the Mac.
Repositories and native credentials remain local.

```text
Product -> Repository -> Work Session -> Task -> Workspace -> Agent Run -> Runtime

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
to **answer** in chat (no tasks), **plan** self-contained tasks that run in parallel
where independent, or **ask** a clarifying question. Output that is not a valid
decision is shown as an answer and never starts builders. A message that is itself
a structured text plan skips the Supervisor. The Supervisor proposes; the backend
validates the plan, and an LLM never authorizes commands or trust.

Ready independent Tasks dispatch concurrently, subject to transactional Node and
profile capacity. Downstream worktrees inherit trusted prerequisite commits;
multiple prerequisite branches are merged in that worktree before execution.
Conflicts preserve the workspace and require human input. Builder and Repair
edits are captured as local candidate commits after terminal runtime success.
A Builder saying “done” does not complete its Task or Session.

Each candidate receives a separate Verifier Run and worktree at its exact SHA.
Codex Verifiers use a read-only sandbox and receive acceptance criteria and
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
exact commit to `origin` as `zamolxis/<short-task>-<sha7>` with the repository's
own Git credentials and hooks (no `--no-verify`, never forced, never the default
branch). If the GitHub CLI is installed and signed in for the remote's host, it
opens a pull request against the default branch (body: task description,
verification evidence, trust decision, "Opened by Zamolxis; merge is a human
decision"); otherwise the Task shows a compare link to open it yourself. Note that
`gh` acts as whichever account is signed in on that Mac. Failures are reported as
codes (`PUBLISH_DIRTY`, `PUBLISH_SHA_MISMATCH`, `PUBLISH_PUSH_FAILED`,
`PUBLISH_PR_FAILED`, `PUBLISH_BASE_UNKNOWN`, `PUBLISH_INTERRUPTED`, …) explained in
plain language, never with remote output; a failed publication can be retried and
does not change the Task or Session outcome. Merging stays a human decision.

**Worktree retention.** Managed worktrees (planning, Builder, Verifier, Repair,
integration) are removed by an hourly backend sweep (`convex/crons.ts`) that sends
`workspace.cleanup` for at most 10 eligible worktrees per online Mac; Settings →
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
provides start, resume, send, stop, inspect and subscribe. The native Codex adapter
is implemented. Claude and Hermes have reserved packages/identities, not working
native adapters; selecting an unavailable runtime fails or waits, without routing
through another vendor.

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
`repository.plan` request and the Node parses them; `supervisorInstruction`
renders them in the same labelled block, but the control-plane driver does not
yet pass them to it, so they do not reach the Supervisor prompt yet. Instructions
are only prompt text: trust decisions, approvals, sandboxing, capacity and
verification never read them.

Each Run snapshots profile ID/revision, owner-instructions digest, runtime,
requested model, reasoning effort and detected runtime version when available. Model/effort propagate through
command parsing, RuntimeManager and Codex startup. Profile edits do not change
historical Runs or replayed launch configuration. Provider-reported actual model
and input/cached/output/total tokens are persisted from normalized usage events.
Missing telemetry stays undefined. No token inference or cost estimate is made.

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

On a Mac with Node >=22, pnpm, Git, Codex CLI and an existing Codex login:

```sh
./scripts/setup.sh
# Or, with dependencies installed:
pnpm zamolxis setup
pnpm zamolxis setup --repair   # non-interactive check and repair
pnpm zamolxis doctor
```

The wizard selects repositories, validates a managed root outside canonical
checkouts, pairs the Node, stores its device credential in the macOS login Keychain
(service `app.zamolxis.node`) and installs its launchd service. Running setup again
offers Check and repair (default: Keychain migration of an older plaintext
credential, credential refresh with re-pairing when revoked, service reinstall when
it points elsewhere, heartbeat), Add or remove repositories, Pair again and Exit.
Renaming a Mac and removing a repository from Zamolxis are not supported by the
backend yet; removal only drops the local grant. Native execution uses
a temporary auth-only Codex profile; user plugins/MCP/config are not copied.
No inbound Mac server is required. See [Alpha setup](docs/alpha-onboarding.md) for
public HTTPS/Google login and device-signing deployment requirements.

Canonical checkouts are never runtime workspaces. Planning, implementation,
verification, repair and integration use separate managed worktrees. The mobile
UI shows task phases, Runs, repair attempts and failure reasons. Its install
manifest supports standalone use; authenticated offline operation is not provided.

## Web app

The web app is phone-first and follows `docs/ui-ux-design-system.md`; shared tokens and
components live in `packages/ui`. It opens on a list of your Sessions; the open Session is
kept in the URL (`?session=<id>`), so refresh and back navigation keep it. A Session shows
your messages, the planning outcome for each, Task cards with their Runs (status, live
activity label, reported token totals) and a Stop control per active Run and per Session.
The composer stays pinned to the bottom; in an ended Session, sending starts a new Session.
Mac status, removal of a Mac and sign-out are in Settings.

Supervisor replies (answers, plans, questions) and each agent's final reply appear in
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

Public phone -> Google/Convex Auth -> pairing -> deployed Convex -> launchd E2E remains untested
without an operator-configured deployment. Native process resumption after Node
restart, a native approval bridge, richer verification modalities and automatic
publishing are not implemented. Repository scripts execute
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
native transport in `packages/runtime-codex`. `convex` owns authenticated
persistence and transactional authorization. Dependency direction points inward;
domain/application do not import native processes or vendor adapters.

[AGENTS.md](AGENTS.md) defines engineering and trust workflows. This executable
repository is the behavioral source of truth. The sibling `zamolxis-docs`
repository contains architectural/reference material; future designs there do not
imply implemented behavior. See [PROJECT.md](PROJECT.md) and the linked issues.
