# Alpha onboarding implementation and acceptance

From a checkout, run one command on macOS or Linux:

```sh
./scripts/setup.sh
```

With dependencies already installed, `pnpm zamolxis setup` starts the same wizard.
It checks Node >=22, pnpm and Git, then reports any authenticated Codex or Claude Code
runtime without requiring one during setup; asks for the public app address and
workstation name; discovers/selects Git repositories;
selects a managed root outside canonical repositories; shows a five-minute QR;
waits for authenticated approval on iPhone; activates a device credential;
registers products/repositories; installs a per-user launchd (macOS) or systemd
(Linux) service; and waits for a fresh heartbeat. No Convex URL, token or ID is
copied by the user. The public app's bootstrap endpoint provides the backend URL.

The versioned local config is an atomic 0600 file in a 0700 directory under
`~/Library/Application Support/Zamolxis` on macOS or
`${XDG_CONFIG_HOME:-~/.config}/zamolxis` on Linux. It contains filesystem grants and
the workstation id, not the device credential. On macOS the credential is a generic
password in
the macOS login Keychain (service `app.zamolxis.node`, account = workstation id;
`pairing-<id>` while a pairing is in progress so an interrupted setup resumes with
the same credential). Setup writes it by piping `add-generic-password … -w <secret>`
to `security -i` on stdin, so the secret never appears in process arguments; it is
read with `security find-generic-password … -w`. Tradeoff: the item trusts
`/usr/bin/security`, so any process running as the same user can read it without a
dialog, as with every `security`-created item; it is still encrypted at rest, locked
with the login Keychain and no longer copied along with config.json. The launchd
agent runs in the user's GUI session and reads the login Keychain while it is
unlocked; if it cannot, it exits with `KEYCHAIN_UNAVAILABLE` (see `node-error.log`).
On Linux, device credentials and per-repository GitHub tokens use separate atomic
0600 JSON files in the same 0700 config directory; symlinks and permissive modes are
refused. The systemd user service is enabled immediately and logs to the user journal.

QR contains only the separate single-use approval code; polling and device
credentials are never placed in that URL. Device tokens expire after fifteen
minutes and are refreshed through the outbound connection. Server revocation blocks
refresh and every authenticated device operation.

Re-running `pnpm zamolxis setup` on a configured Mac shows a menu:

- **Check and repair** (default): prerequisites, config validity, moves a plaintext
  credential from an older config.json into the Keychain (then removes it from the
  file), refreshes the credential; if it is missing or rejected (the Mac was removed
  or revoked in Settings) explains why and offers to pair again with a new QR;
  re-registers repositories; checks that the launchd service exists, is loaded and
  runs this checkout's `daemon.ts` (reinstalls it otherwise, restarts it after a
  credential or repository change and checks it stays up). After a (re)start it
  waits for a heartbeat from the new Node process: `node:health` reports
  `lastHeartbeatAt` and the Node instance id (new for every process start), and
  setup requires an instance id different from the one seen before the restart
  with a later heartbeat. If only the old process keeps reporting, setup says so.
- **Add or remove repositories:** the checklist with current grants checked and
  discovered repositories unchecked. Unchecked repositories are recorded as removed
  for this Mac (`repositories:removeOwnLocation`): no new work is dispatched to that
  location. A repository with work still running there (unfinished or uncertain
  runs, or workspaces being prepared, used or integrated) is refused with
  `LOCATION_BUSY`; setup keeps it granted and says so. The repository, its Product
  and history stay in Zamolxis. The checked list is confirmed as a re-grant, so a
  location removed earlier (also one removed in Settings) becomes eligible again
  once the restarted Node registers it. A plain Check and repair never re-grants.
- **Rename this Mac:** asks for a name (trimmed, 1 to 64 characters), renames the
  workstation with the Mac's own credential (`workstations:renameSelf`) and updates
  `config.json`. No restart is needed.
- **Pair again:** new QR, new device credential (the old Keychain item is removed).
  Once the new pairing works, setup uses the previous credential, if it is still
  valid, to revoke the previous Mac entry (`workstations:retireReplaced`, recorded
  as `replacedBy` the new entry). If that credential is gone or no longer accepted
  (also when Check and repair had to pair again), the old entry is left as it is
  and setup says so; remove it in Settings → Computers. If setup is interrupted before
  the new pairing completes, the old entry is not revoked.
- **Exit.**

In the app, **Settings → Computers** offers the same management from iPhone:
**Rename** (`workstations:rename`, owner only), **Repositories** (the locations the
Mac may work on, each with **Remove from this Mac…**, `repositories:removeLocationForOwner`,
refused while work runs there) and **Remove this Mac…** (revoke). A location removed
in Settings stays removed across Node restarts; re-add it with setup's
"Add or remove repositories" on that Mac.

## Onboarding progress in the app

Until the first session exists, the sessions screen shows a **Get started** checklist
(phone-first; **Hide checklist** hides it in this browser). Each step is derived by
the owner-scoped query `onboarding:progress` from stored state only, never assumed:

| Step | Done when | Otherwise |
| --- | --- | --- |
| Sign in, Access approved | the query runs (it requires an allowed sign-in) | the app shows the access screen instead |
| Pair your Mac | a non-revoked Mac has an activated device credential or has sent a heartbeat | no Mac: needs you ("run `pnpm zamolxis setup`, scan the QR code"); approved but not activated: in progress |
| Choose repositories | the Mac has at least one available repository location | locations all removed, or none registered while the Mac runs: needs you; locations missing/invalid: failed; registered but not yet checked by the Node: in progress |
| Start Zamolxis on your Mac | heartbeat within the last 45 s | no heartbeat yet: in progress; heartbeat older than 45 s: failed ("offline — run `pnpm zamolxis setup --repair`") |
| Agent runtime ready | the workstation's last heartbeat reported an authenticated runtime with start capability | failed (install and sign in to Codex or Claude Code, then restart the service) |
| Start your first session | a session exists | needs you once every step above is done |

The Mac considered is the furthest along (online first, then most recent heartbeat,
then newest). A query result does not age by itself, so the "online" step carries the
time after which the app shows it as offline without a new heartbeat. The backend
cannot see launchd itself: the service counts as running once a heartbeat arrives.
The Node starts and pairs without Codex. Until an authenticated Codex or Claude Code
runtime is available it reports no runtime capabilities, so work cannot dispatch.
Pending QR requests are not linked to an
owner until approved, so "scan the QR code" is not tracked before approval.

`pnpm zamolxis setup --repair` runs Check and repair without prompts (for scripts);
when the Mac must be paired again it stops and says so. `pnpm zamolxis doctor`
checks local prerequisites without installing a service.

The Node service uses a temporary Codex profile containing only the existing
login, with no copied native plugin/MCP/config grants. It uses the real runtime,
managed worktrees and durable outbox, performs repository capability discovery
before each assigned run and keeps uncertainty/leases for reconciliation. The
cloud reserves three builder slots and one separate verifier slot, including
queued and uncertain owned runs. Local dispatch launches at most 3+1 concurrently.

## Deployment requirements (operator, not end-user setup)

A public HTTPS frontend and reachable Convex deployment must exist before an
actual iPhone can pair. Configure `NEXT_PUBLIC_CONVEX_URL` and the canonical HTTPS origin
`ZAMOLXIS_APP_URL` on the frontend.
Human sign-in now uses Convex Auth with Google. Follow
[Google login and database access](google-auth-access.md) for `AUTH_GOOGLE_ID`,
`AUTH_GOOGLE_SECRET`, `SITE_URL`, `JWT_PRIVATE_KEY` and `JWKS` in Convex.
The callback is the deployment HTTP Actions URL plus `/api/auth/callback/google`,
not the old frontend `/api/auth/callback`. Approve each Google user's
`users.accessStatus` in the database before they can view Products or pair a Mac.

Node identity remains separate: `CONVEX_SITE_URL`, `ZAMOLXIS_DEVICE_PRIVATE_KEY`
and matching `ZAMOLXIS_DEVICE_JWKS` with a `kid`. Generate separate human/Node key
pairs; private keys stay in deployment secrets. No end-user enters these values
in the Mac wizard. Missing/mismatched keys fail closed. The old
`ZAMOLXIS_OIDC_*` and `ZAMOLXIS_AUTH_ISSUER`/`ZAMOLXIS_AUTH_AUDIENCE` variables
are no longer used. Google credentials and live signing keys have not been
configured by this implementation.

## Verified and remaining acceptance

Authenticated Codex inference on this Mac passed on 2026-10-05. Reproduce:

```sh
apps/node/node_modules/.bin/tsx scripts/codex-acceptance.mts --authenticated
```

The deeper explicit opt-in test uses real Mac-authenticated Codex through Node,
a real managed Git worktree, SQLite outbox and actual Convex function
implementations in convex-test (control-plane identity is a fixture):

```sh
ZAMOLXIS_AUTHENTICATED_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t 'accepts real authenticated Mac'
```

This is not a deployed device-authentication or iPhone test. Full public
Google/Convex Auth→QR→device JWT→launchd→phone command E2E still requires a configured deployment.
Local tests cover approval authentication, separate QR/poll secrets, expiration,
single use, real JWT signature, revocation, idempotent repository registration,
3+1 reservation, lost-run capacity retention, Product isolation, idempotent text
commands, provisioning-before-dispatch and explicit Session reuse.

The deterministic Supervisor now obtains SHA-bound repository context in a
separate planning worktree before creating Tasks. Prose produces one Task;
structured text plans support concurrent Tasks and validated DAG dependencies.
Builder/Repair edits become candidate commits, followed by independent read-only
Codex verification, executable repository checks and deterministic trust. Failure
allows two repairs; exhaustion requires input. Trust PASS prepares a separate
local integration branch and records its exact SHA before completing the Task.
Publishing it as a pull request happens only when you choose "Open pull request"
on the Task; protected-main merge remains a human action. See README for the
structured plan format and limitations.

The complete local acceptance is reproducible with:

```sh
ZAMOLXIS_CODEX_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t 'runs text intent'
```

On 2026-10-05 this passed with the installed Codex 0.160.0: real Builder edits,
a candidate commit, a separate Verifier Run/worktree, executed acceptance script,
SHA-bound evidence, deterministic trust and a prepared integration worktree.
Canonical HEAD and status remained unchanged; temporary auth-only profile was
removed. It uses actual backend functions in convex-test and fixture identities.
It does not prove public OIDC/device authentication or phone E2E. The default
fixture-runtime acceptance also exercises failed trust, Repair and re-verification;
a separate test proves two actual concurrent Builders and trusted dependency
commit propagation.

Live deployment validation was not performed. Automatic approval review rejected
`convex dev --once` because it could upload backend source or mutate a hosted
deployment. No deployment settings or signing keys were changed. Typechecks,
Convex-function tests and local native acceptance remain independently runnable.
