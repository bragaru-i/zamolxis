# Alpha status and handoff

Status as of 2026-10-06, main at `a644ae2` (after #57–#62). Alpha is **not finished**:
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
  `runtime.stop` (delivered while a run streams, via a separate control loop),
  `workspace.cleanup`, `integration.prepare`. Unknown or malformed commands fail
  individually and no longer block the queue (#60).
- **Web app (#61):** phone-first sessions list; open session kept in `?session=<id>`;
  your messages with their planning outcome, task cards with runs (status, activity
  label, token totals), Stop per run and per session, pinned composer, Settings sheet
  (Macs, removal, sign-out), iOS safe areas. Shared tokens and components live in
  `packages/ui`.
- **Release (#62):** `pnpm deploy:prod` (see README "Deploying production").

## Gaps blocking Alpha

1. **No real Supervisor (#49).** Planning is deterministic
   (`packages/node-core/src/capabilities/alpha-plan.ts`): prose becomes exactly one
   task; several tasks only when the user types JSON `{ "tasks": [...] }`.
   `packages/supervisor` (`planWithRepositoryContext`) is not imported anywhere
   outside its own tests. No Supervisor agent run exists, so there are no
   "orchestrator jobs" to show. Supervisor and Integration agent profiles are stored
   but never resolved.
2. **No conversation text.** No message table for agent replies. Codex
   `agentMessage` content is reduced to the label "Agent responding" and completion
   to the fixed summary "Codex turn completed"
   (`packages/runtime-codex/src/codex-runtime.ts`); verifier review text is
   discarded. The UI shows user messages and planning outcomes only.
3. **No steering.** `runtime.send` fails with `RUNTIME_SEND_UNSUPPORTED`; the Node does
   not advertise the `message` capability. Follow-up messages create a new plan in the
   same session (refused once the session has ended; the UI then starts a new one).
4. **Profiles and usage (#48):** backend only. No Agents settings or usage screens, no
   cost data, no instruction/policy references on profiles.
5. **Identity (#47):** user approval is a manual edit of `users.accessStatus` in the
   Convex dashboard; no listing or revocation of browser sessions; no service worker.
6. **Onboarding (#45):** the Node credential is stored in the 0600 config file, not the
   Keychain; rerunning setup with an existing config skips the wizard (no repository
   reselection, no repair of a revoked/expired credential); no web onboarding
   progress.
7. **Integration** stops at a local branch; nothing pushes or opens a PR.
8. **Not validated end to end:** real iPhone (keyboard with the pinned composer,
   home-screen mode), deployed OIDC/device auth, launchd service across restarts,
   stop against a real Codex session.

## Next steps, in order

1. Real Supervisor (#49): a Supervisor agent run using the resolved Supervisor
   profile, wired to `packages/supervisor`, producing a validated multi-task plan;
   visible as its own run in the session.
2. Conversation layer: persist agent and Supervisor reply text (bounded), render it in
   the session view; implement `runtime.send` with conversation-aware completion.
3. Agents settings and usage screens (#48); access approval UI (#47).

## Operations on the owner's Mac

- Canonical checkout: `/Users/Shared/projects/zamolxis`. The launchd Node runs
  `apps/node/src/daemon.ts` from it, so `git pull` plus a restart updates the Node:
  `launchctl kickstart -k gui/$(id -u)/app.zamolxis.node`. Logs:
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
  updated by it: `git pull` in the canonical checkout, then
  `launchctl kickstart -k gui/$(id -u)/app.zamolxis.node` (or
  `pnpm deploy:prod --pull --skip-convex --skip-web`). `pnpm deploy:prod` is the
  manual full release (needs `pnpm dlx vercel@62 login` once).
- The private prod setup directory is at
  `~/Library/Application Support/Zamolxis/prod-setup` (moved out of `/private/tmp`).
- CI on GitHub occasionally leaves jobs queued with no runner until they are cancelled
  after 15 minutes; that shows as a failure without any step running. Re-run the job
  before treating it as a code failure.
