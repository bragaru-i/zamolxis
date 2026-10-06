# Alpha onboarding implementation and acceptance

From a checkout, run one command on Mac:

```sh
./scripts/setup.sh
```

With dependencies already installed, `pnpm zamolxis setup` starts the same wizard.
It checks Node >=22, pnpm, Git, Codex CLI and existing Codex authentication;
asks for the public app address and Mac name; discovers/selects Git repositories;
selects a managed root outside canonical repositories; shows a five-minute QR;
waits for authenticated approval on iPhone; activates a device credential;
registers products/repositories; installs a per-user launchd service; and waits
for a fresh heartbeat and runtime registration. No Convex URL, token or ID is
copied by the user. The public app's bootstrap endpoint provides the backend URL.

The versioned local config is an atomic 0600 file in a 0700 directory under
`~/Library/Application Support/Zamolxis`. It contains filesystem grants and the
workstation id, not the device credential. The credential is a generic password in
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
  credential or repository change and checks it stays up); waits for the heartbeat.
- **Add or remove repositories:** the checklist with current grants checked and
  discovered repositories unchecked; additions are registered, then the service
  restarts. Removal only drops the local grant: no backend function removes a
  repository, so it and its Product stay in Zamolxis.
- **Rename this Mac:** shown as unavailable; the backend cannot rename a Mac yet.
- **Pair again:** new QR, new device credential (the old Keychain item is removed).
  Approval creates a new Mac entry; remove the old one in Settings.
- **Exit.**

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
