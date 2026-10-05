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
`~/Library/Application Support/Zamolxis`. It contains the local device credential
and filesystem grants. QR contains only the separate single-use approval code;
polling and device credentials are never placed in that URL. Device tokens expire
after fifteen minutes and are refreshed through the outbound connection. Server
revocation blocks refresh and every authenticated device operation. Re-running
setup reuses registration/config and checks the existing service and heartbeat.
`pnpm zamolxis doctor` checks local prerequisites without installing a service.

The Node service uses a temporary Codex profile containing only the existing
login, with no copied native plugin/MCP/config grants. It uses the real runtime,
managed worktrees and durable outbox, performs repository capability discovery
before each assigned run and keeps uncertainty/leases for reconciliation. The
cloud reserves three builder slots and one separate verifier slot, including
queued and uncertain owned runs. Local dispatch launches at most 3+1 concurrently.

## Deployment requirements (operator, not end-user setup)

A public HTTPS frontend and reachable Convex deployment must exist before an
actual iPhone can pair. Configure `NEXT_PUBLIC_CONVEX_URL` on the frontend.
The frontend OIDC authorization-code/PKCE flow needs `ZAMOLXIS_OIDC_ISSUER`,
`ZAMOLXIS_OIDC_CLIENT_ID`, and, only for a confidential client,
`ZAMOLXIS_OIDC_CLIENT_SECRET`. Register the exact public
`/api/auth/callback` URL with the provider. Convex's existing
`ZAMOLXIS_AUTH_ISSUER`/`ZAMOLXIS_AUTH_AUDIENCE` must accept that provider's ID token.

The device issuer uses `CONVEX_SITE_URL`, an operator-managed RSA private key
`ZAMOLXIS_DEVICE_PRIVATE_KEY`, and matching public `ZAMOLXIS_DEVICE_JWKS` containing
a `kid`. Private key stays in deployment secrets. The public JWKS is included in
Convex custom-JWT configuration with fixed RS256 and `zamolxis-node` audience.
No user supplies these values in the Mac wizard. Missing/mismatched keys fail
closed. This session did not configure production signing keys or OIDC.

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
OIDC→QR→device JWT→launchd→phone command E2E still requires a configured deployment.
Local tests cover approval authentication, separate QR/poll secrets, expiration,
single use, real JWT signature, revocation, idempotent repository registration,
3+1 reservation, lost-run capacity retention, Product isolation, idempotent text
commands, provisioning-before-dispatch and explicit Session reuse.

The minimal deterministic Supervisor currently creates one implementation task
from a text command and dispatches after provisioning. Successful implementation
keeps the Session waiting; it cannot imply trust, verification or integration.
Autonomous verifier planning/evidence collection, repair and integration are
still incomplete and are required before calling the whole Alpha ready.
The UI accurately displays this waiting state. No launch-ready claim is made.
