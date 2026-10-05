# Google sign-in and database-controlled access

Authentication runs in Convex Auth; Google supplies the identity. No Auth0,
Clerk or other hosted auth service is required. Convex Auth is currently beta.
Frontend private product data is client-rendered behind an access gate; the
backend is the authority. Convex Auth owns session/token refresh and sign-out.

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

1. The user opens the web app and chooses **Continue with Google**.
2. Their verified Google profile creates a `users` row. They see **Access pending**.
3. In Convex Dashboard → Data → `users`, find the intended account by email.
4. Add/edit `accessStatus` with the string value `allowed` to grant access.
5. Set it to `blocked` to revoke access; `pending` or removing the field also denies access.

There is no first-user auto-approval. Approve your own account this same way.
Operators with Convex dashboard/data-write privileges control grants; ordinary
web users cannot change them. Returning Google sign-in never resets a grant.
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
