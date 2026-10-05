# Alpha status and handoff

Status as of 2026-10-06, main at `719a7bd` (after #57–#69). Alpha is **not finished**:
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
- **Release (#62, #64):** every push to main that passes CI deploys Convex and the
  web app automatically; `pnpm deploy:prod` is the manual path.
- **Supervisor and conversation (#66):** see gap 1 and 2 below.
- **Access administration (#67):** Settings → People (admins approve, block,
  restore, promote; blocking revokes all sign-ins) and Settings → Signed-in devices.
  First admin via the internal `admin:bootstrapAdmin` (done on prod for the owner).
- **Agents and usage (#68):** Settings → Agents (effective profile per role, edit
  runtime/model/effort, turn off), Settings → Usage (24h/7d/30d tokens by role and
  model, top sessions) and a Usage row per session. Cost appears only if a provider
  reports it (nothing does today).
- **Run detail (#68):** tapping a run opens result, grouped live activity, changes
  (files, base → head, branch) and verification (evidence, trust decision, repairs).
- **Setup repair (#69):** rerunning setup offers Check and repair, repositories,
  pairing again; `--repair` is non-interactive; the device credential lives in the
  login Keychain (migrated on the owner's Mac on 2026-10-06).

## Gaps blocking Alpha

1. **Supervisor (#49), shipped as answer/plan/ask.** Every message runs a read-only
   Supervisor agent on the Node (`packages/node-core/src/capabilities/supervisor.ts`,
   run id `supervisor:<textCommandId>`, runtime/model from the Supervisor profile with a
   fallback to a registered runtime). It answers questions in chat, plans
   self-contained parallel tasks, or asks a clarifying question; unparseable output is
   treated as an answer and never starts builders. Still missing: the Supervisor is not
   an agent run in the backend, so it cannot be stopped from the UI and its events are
   not shown; `packages/supervisor` is still unused; a real Codex Supervisor run (prompt
   quality, JSON compliance) is only covered by the authenticated acceptance.
2. **Conversation, partially shipped.** Supervisor replies (Markdown, bounded to 8000)
   and builder/verifier final replies (`agentRuns.resultSummary`) are shown. Not yet:
   intermediate agent messages, verifier review text beyond its final message.
3. **No steering.** `runtime.send` fails with `RUNTIME_SEND_UNSUPPORTED`. A follow-up
   message is a new Supervisor turn in the same session (with the earlier
   conversation), and reopens a completed session. A reopened *failed* session can
   return to failed on the next lifecycle refresh (`convex/lib/lifecycle.ts`).
4. **Profiles and usage (#48), mostly shipped.** Missing: editing profile name and
   max concurrency in the UI, instruction/policy references on profiles, any cost data
   source.
5. **Identity (#47), mostly shipped.** Missing: device names for signed-in sessions
   (Convex Auth stores no user agent), service worker, a live second-account test.
6. **Onboarding (#45), mostly shipped.** Missing: web onboarding progress, workstation
   rename and backend repository removal (no backend functions), automatic revoke of
   the old Mac entry after pairing again, an exact heartbeat check (`node:health` is
   only a boolean). Fixed after the first real run: repair could leave the service
   unloaded when launchd was still unloading (wait and retry added).
7. **Integration** stops at a local branch; nothing pushes or opens a PR.
8. **Not validated end to end:** real iPhone (keyboard with the pinned composer,
   home-screen mode), deployed OIDC/device auth, launchd service across restarts,
   stop against a real Codex session.

## Next steps, in order

1. Approvals bridge and steering (wave 2, lane D, in progress): Codex approval
   requests reach the phone; `runtime.send` to running and waiting agents.
2. Make the Supervisor a stoppable, visible run; real-Codex validation of answers.
3. Codex tool summaries (show the actual command) and trace recording on the Node.
4. Real-device validation: iPhone, launchd across reboot, stop against Codex.

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
