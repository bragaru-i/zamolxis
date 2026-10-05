# Google sign-in and database-controlled access

Authentication runs in Convex Auth; Google supplies the identity. No Auth0,
Clerk or other hosted auth service is required. Convex Auth is currently beta.
Frontend private product data is client-rendered behind an access gate; the
backend is the authority. Convex Auth owns session/token refresh and sign-out.

## Guided setup: development and production

Run this flow separately for your Convex **dev** and **prod** deployments.
Environment variables, signing keys, user grants and Google clients are separate.
Use a dedicated Google Web application OAuth client for each environment. Each
frontend uses its matching Convex deployment and stable HTTPS origin. Development
also requires HTTPS under Zamolxis's origin policy (plain localhost is rejected).

From updated `main`, install dependencies with `pnpm install --frozen-lockfile`.
Prepare development, replacing the deployment name and frontend origin:

```sh
node scripts/google-auth-setup.mjs prepare \
  --environment dev \
  --deployment YOUR-DEV-DEPLOYMENT \
  --convex-url https://YOUR-DEV-DEPLOYMENT.REGION.convex.cloud \
  --app-url https://YOUR-DEV-APP-ORIGIN \
  --directory /private/tmp/zamolxis-google-dev
```

Use the actual lowercase deployment name from its `.convex.cloud` URL, not the
project name. Copy the full Deployment URL from Convex into `--convex-url`;
retain the region if present (for example `.eu-west-1.convex.cloud`). The helper
preserves that region in both the frontend URL and Google callback. Older
non-regional deployments can omit `--convex-url`. Choose a new absolute private
directory outside the repository.
Preparation is offline: it generates separate human/Node keys and prints the
exact Google JavaScript origin and `.convex.site` callback URL. It refuses an
existing directory, so rerunning preparation cannot rotate existing keys.

In Google Auth Platform → Clients, create a **Web application** client with the
printed origin and redirect URI. Add your account as a test user if the Google
app is in Testing. Then edit the generated `credentials.json` privately:

```json
{
  "googleClientId": "YOUR-ID.apps.googleusercontent.com",
  "googleClientSecret": "YOUR-GOOGLE-SECRET",
  "deployKey": "dev:YOUR-DEV-DEPLOYMENT|YOUR-DEPLOYMENT-KEY"
}
```

Get a deployment-scoped key from **that deployment's** Convex Settings → Deploy
keys. It needs environment-variable read/write permissions for `apply`, and
code deployment permissions for `deploy`. Project-wide keys, legacy keys and
keys for another environment/deployment are rejected. This avoids changing the
machine's global Convex login or other products' configuration. Keep this file
private (0600); do not paste its contents into chat or commit it.

Review the target, apply auth variables, then deploy the backend:

```sh
node scripts/google-auth-setup.mjs inspect --environment dev --directory /private/tmp/zamolxis-google-dev
node scripts/google-auth-setup.mjs apply --environment dev --directory /private/tmp/zamolxis-google-dev
node scripts/google-auth-setup.mjs deploy --environment dev --directory /private/tmp/zamolxis-google-dev
```

`inspect` is offline. `apply` writes only the seven auth variables in one batch;
it refuses all writes when any existing value differs, protecting established
keys and origins. Reapplying the same bundle is idempotent. For an already
configured deployment, resolve differences explicitly in its Dashboard rather
than generating/replacing keys blindly. `deploy` uploads the current checkout's
backend/schema and performs Convex's checks; it does not deploy the frontend.
CLI output is suppressed to avoid leaking credentials; a failed command reports
the operation and target without secrets. A temporary private CLI credentials
file is removed after the command. No global login is modified.

Import the generated `frontend.env` values into the **development web app's**
hosting environment, then build/deploy that frontend. Open it, sign in and grant
your user `accessStatus: "allowed"` in the **dev deployment's** `users` table.
Verify a pending account is denied and blocking your test account revokes access.

For production, repeat with production-specific values and a separate Google
client. Do not copy the dev credential file or signing keys:

```sh
node scripts/google-auth-setup.mjs prepare \
  --environment prod \
  --deployment YOUR-PROD-DEPLOYMENT \
  --convex-url https://YOUR-PROD-DEPLOYMENT.REGION.convex.cloud \
  --app-url https://YOUR-PROD-APP-ORIGIN \
  --directory /private/tmp/zamolxis-google-prod
# Create the production Google client and fill this directory's credentials.json.
node scripts/google-auth-setup.mjs inspect --environment prod --directory /private/tmp/zamolxis-google-prod
node scripts/google-auth-setup.mjs apply --environment prod --directory /private/tmp/zamolxis-google-prod
node scripts/google-auth-setup.mjs deploy --environment prod --directory /private/tmp/zamolxis-google-prod
```

Configure production hosting from the production `frontend.env`. Approve your
production user and bootstrap its administrator separately (see "First
administrator" below). Store both private bundles in operator secrets
storage; `/private/tmp` is temporary and is not a backup. After setup, pair each
Mac with the intended public application origin using `./scripts/setup.sh`.

The helper has offline tests for target mismatch rejection, dev/prod key
separation, permissions and inherited selector isolation. Hosted `apply`,
`deploy` and Google login have not been exercised without your credentials.

## Operator setup

Use a dedicated Zamolxis deployment and one stable public HTTPS frontend origin.
For the frontend, configure `NEXT_PUBLIC_CONVEX_URL` and `ZAMOLXIS_APP_URL`.
In Convex, set `SITE_URL` to exactly that same HTTPS origin. Preview origins
must not share trusted production configuration.

In Google Cloud's Google Auth Platform, create a Web application OAuth client.
Add the frontend origin as an authorized JavaScript origin. Register this exact
redirect URI using your Convex HTTP Actions URL (ends in `.site`):

```text
https://YOUR-DEPLOYMENT.convex.site/api/auth/callback/google
```

For a Google app in Testing, add your intended accounts as Google test users.
Google's test-user list and Zamolxis's database access policy are separate gates.
Copy the OAuth client ID and secret into Convex deployment environment variables
`AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`, not the frontend.

Generate keys locally, outside the repository, into a new private directory:

```sh
node scripts/generate-auth-keys.mjs /private/tmp/zamolxis-auth-keys
```

The utility creates separate human and Node RSA keys with private file
permissions, prints only the directory, and refuses existing directories. Put
the full file contents in these Convex deployment environment variables:

| Variable | Generated file |
| --- | --- |
| `JWT_PRIVATE_KEY` | `JWT_PRIVATE_KEY.pem` |
| `JWKS` | `JWKS.json` |
| `ZAMOLXIS_DEVICE_PRIVATE_KEY` | `ZAMOLXIS_DEVICE_PRIVATE_KEY.pem` |
| `ZAMOLXIS_DEVICE_JWKS` | `ZAMOLXIS_DEVICE_JWKS.json` |

`CONVEX_SITE_URL` is built in. Human tokens use audience `convex`; Node tokens
use `zamolxis-node`. Do not reuse the two key pairs. Store private material in
operator secrets storage and remove temporary files when setup is finished.
Do not paste secrets in chat or commit them. Deploy backend/auth configuration
and frontend to the selected environment after configuring the variables.

Official references: [Convex Auth setup](https://labs.convex.dev/auth/setup/manual)
and [Google configuration](https://labs.convex.dev/auth/config/oauth/google).

## Grant or revoke access

New users choose **Continue with Google**; their verified Google profile creates
a `users` row and they see **Access pending** until someone approves them.

### First administrator (once per deployment)

1. Sign in once with Google; you see **Access pending**.
2. In Convex Dashboard → Data → `users`, set your row's `accessStatus` to the
   string `allowed`.
3. Promote that approved account with the internal mutation
   `admin:bootstrapAdmin`: Dashboard → Functions → `admin` → `bootstrapAdmin` →
   Run with `{"email": "you@example.com"}`, or with that deployment's credentials:

   ```sh
   npx convex run admin:bootstrapAdmin '{"email":"you@example.com"}'        # dev
   npx convex run admin:bootstrapAdmin '{"email":"you@example.com"}' --prod # prod
   ```

`bootstrapAdmin` is internal, so browsers cannot call it. It is idempotent: if an
approved administrator already exists it changes nothing and returns
`status: "exists"`. Otherwise it promotes exactly one **approved** user: the one
whose email matches `email`, or, with `{}`, the only approved user. It refuses
(`BOOTSTRAP_AMBIGUOUS`) when no approved user or more than one matches. Pending
and blocked accounts are never eligible. Deploys do not run it, and nobody
becomes administrator by signing in first.

### Day to day, in the app

Administrators see **Settings → People**. People waiting for approval are listed
first, with email, name, when they joined and when they last signed in.

- **Approve** sets `accessStatus` to `allowed`.
- **Block** sets `blocked` and signs the person out everywhere: all their Convex
  Auth sessions and refresh tokens are deleted, so existing browser tokens fail on
  the next backend call. Their Products, sessions and history are kept.
- **Restore access** approves a blocked person again.
- **Make admin / Remove admin** changes another approved person's role.

Each action asks for confirmation and is idempotent. You cannot change your own
access or role, so the last administrator cannot be removed. Anyone blocked or set
back to pending loses the administrator role (`users.role`). Every admin function
authorizes the signed-in session server-side; the role never comes from client
input. Operators can still edit `users.accessStatus` in the Dashboard.

Everyone with access sees **Settings → Signed-in devices**: their own Convex Auth
sessions (signed in, last active, expiry; the current device is marked). **Sign
out…** ends one other browser; **Sign out all other devices** ends all but the
current one. Convex Auth does not record browser or device names, so entries are
described by time. Use **Sign out** for the current device.

There is no first-user auto-approval; the first approval is a Dashboard edit.
Ordinary web users cannot change grants. Returning Google sign-in never resets a grant.
The allow decision is attached to the authenticated user's immutable ID, not a
client-submitted email. Access is reactive; existing sessions are checked on
backend calls. A deleted or expired auth session is also denied.

Unapproved users can read only their own email/ID/access state, sign out and use
the login flow. They cannot enumerate Products, create repositories, submit work,
approve pairing or change access. All existing ownership/Product isolation still
applies after approval; access is not collaboration across owners.

Blocking an owner also denies existing Nodes' cloud APIs, pending enrollment
activation and credential refresh. It does not terminate work already executing
locally. Reconciliation preserves history/leases instead of starting duplicates.

## Existing deployment migration

The old external OIDC provider config and frontend callback have been removed.
Existing user fields/ownership IDs remain schema-compatible; rows without an
explicit grant are denied. Old external OIDC tokens no longer authenticate.
Existing external identities are not automatically linked to new Google users.
For a populated deployment, the operator must plan verified account linking and
ownership migration before switching. Never transfer ownership based only on an
unverified or client-supplied email. This change does not rewrite existing data.

## Validation boundary

Tests exercise pending/allowed/blocked access, direct API denial, live/mismatched/
deleted/expired sessions, Node denial, immutable user identity, verified Google
profiles, redirect confinement and the existing isolated trust lifecycle. The
schema preserves Convex Auth's runtime validators/indexes without relaxing strict
TypeScript optional-field checks.

The deployed human-access smoke uses an actual approved session token held only
in your local environment (`CONVEX_URL`, `ZAMOLXIS_SMOKE_TOKEN`):

```sh
apps/node/node_modules/.bin/tsx scripts/live-smoke.mts
```

It performs read-only access checks and does not replace issuer/signing keys or
grant access. It is not Google browser, phone pairing or runtime E2E. Real Google
OAuth acceptance requires operator client credentials and a deployed backend;
it has not been run by this implementation.
