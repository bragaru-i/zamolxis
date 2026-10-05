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
arbitrary shell commands in check specifications. Planning is deterministic:
prose creates one Task; a structured text plan can express multiple Tasks and a
DAG. An LLM does not authorize commands or trust. Semantic LLM decomposition of
arbitrary prose is not implemented.

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
**prepares local integration branches**; it does not automatically push them,
open candidate PRs, combine independent output branches into one release, or
merge protected main. Use a final Task depending on independent branches when a
combined verified result is needed. Publishing and protected-main merge remain
human actions. Branch protections and CODEOWNERS are never bypassed.

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
own effective configuration. Supervisor and Integration profile roles are stored
for future runtime execution; those two boundaries are deterministic in Alpha.

Each Run snapshots profile ID/revision, runtime, requested model, reasoning effort
and detected runtime version when available. Model/effort propagate through
command parsing, RuntimeManager and Codex startup. Profile edits do not change
historical Runs or replayed launch configuration. Provider-reported actual model
and input/cached/output/total tokens are persisted from normalized usage events.
Missing telemetry stays undefined. No token inference or cost estimate is made.

The server reserves **3 Builder-class slots (Builder + Repair) and 1 Verifier
slot**. Queued and lost/uncertain owned Runs continue reserving capacity until
settlement/reconciliation. Profile concurrency is an additional owner-wide limit,
including across Nodes and profile revisions. UI limits are not authority.

## Identity, pairing and setup

One configured public HTTPS origin (`ZAMOLXIS_APP_URL`) binds OAuth redirects,
bootstrap metadata and QR links. Incoming Host headers and preview URLs do not
establish trusted origins. Human OIDC identity and Node-scoped identity are
separate. QR approval enrolls a Mac; it is not human authentication. An authenticated
owner approves a five-minute single-use QR request. Private local configuration,
short-lived signed device tokens and revocation protect outbound Node access.

On a Mac with Node >=22, pnpm, Git, Codex CLI and an existing Codex login:

```sh
./scripts/setup.sh
# Or, with dependencies installed:
pnpm zamolxis setup
pnpm zamolxis doctor
```

The wizard selects repositories, validates a managed root outside canonical
checkouts, pairs the Node and installs its launchd service. Native execution uses
a temporary auth-only Codex profile; user plugins/MCP/config are not copied.
No inbound Mac server is required. See [Alpha setup](docs/alpha-onboarding.md) for
public HTTPS/OIDC and device-signing deployment requirements.

Canonical checkouts are never runtime workspaces. Planning, implementation,
verification, repair and integration use separate managed worktrees. The mobile
UI shows task phases, Runs, repair attempts and failure reasons. Its install
manifest supports standalone use; authenticated offline operation is not provided.

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
not deployed OIDC/device auth.

Public phone -> OIDC -> pairing -> deployed Convex -> launchd E2E remains untested
without an operator-configured deployment. Native process resumption after Node
restart, a native approval bridge, richer verification modalities, semantic LLM
planning and automatic publishing are not implemented. Repository scripts execute
with local Node authority and must be trusted by the repository owner; Alpha is
not a sandbox for hostile repository code. Node reconciliation preserves ambiguous
leases instead of silently starting a second process.

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
