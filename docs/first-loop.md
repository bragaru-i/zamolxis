# First Fake Runtime loop

The local acceptance test exercises Session → Task → Workspace provisioning command → actual Git worktree → runtime start command → Fake Runtime → durable SQLite outbox → Convex event ingestion and final snapshot → completed Session. It verifies that canonical HEAD and working tree stay unchanged. The test uses the real Convex function implementations through convex-test, rather than a deployed backend.

The Node driver handles workspace.provision, repository.plan, runtime.start, runtime.stop, runtime.send, runtime.approval, workspace.cleanup and integration.prepare. It validates cloud command targets, derives filesystem paths from the local repository registry and managed workspace, and only runs allowed registered adapters. The supplied entry point registers only FakeRuntime. Each pending command is parsed individually: an unknown or malformed command fails on its own and never blocks the rest of the queue. Stop, message and approval commands are checked on a separate control loop so they reach a run that is still streaming; the run's own terminal outcome is settled before a stop completes, and a message or approval for a waiting run follows it to its next pause.

Results and outgoing deliveries commit together in SQLite. Events are delivered before the final Run snapshot, then the command outcome. A lost acknowledgement replays the same ordered event IDs. A completed command can be acknowledged by a new Node instance only after the server already observed its ready workspace or native session/final snapshot. An interrupted local execution remains running and requires reconciliation; the driver never silently launches another runtime.

## Live development smoke path

Configure the development Convex deployment's OIDC issuer and audience first, and enroll a separate device subject with a signed ownerSubject claim. Create a user profile, workstation, logical repository and Session/Task through the authenticated user API. Tokens are supplied through the environment and are never logged or written by this entry point.

For the Node, set CONVEX_URL, ZAMOLXIS_DEVICE_TOKEN, ZAMOLXIS_WORKSTATION_ID, ZAMOLXIS_REPOSITORY_ID, ZAMOLXIS_REPOSITORY_PATH, ZAMOLXIS_REPOSITORY_REMOTE and ZAMOLXIS_MANAGED_ROOT. The managed root must already exist and be outside the canonical repository. These explicit local paths are filesystem grants; cloud commands cannot supply cwd or shell commands.

Run `pnpm --filter @zamolxis/node fake-loop` once to register the verified repository location. Request a Workspace for the Task using that location, run the command again to provision it, request a Fake Run, then run it again to execute and flush deliveries. Each invocation creates a new Node instance and conservatively preserves uncertain prior execution.

A minimal reactive debug consumer is available as `pnpm --filter @zamolxis/node watch-session`. It requires CONVEX_URL, ZAMOLXIS_USER_TOKEN and ZAMOLXIS_SESSION_ID and subscribes to Session counters and Run activity/status. This is a developer smoke viewer, not a completed product UI or authentication flow.

Live verification on 2026-10-04 deployed these functions to a loopback Convex backend and ran the actual Node entry path with signed user/device tokens. Session and Run completed, three ordered events persisted, the reactive viewer updated, and canonical HEAD/status stayed unchanged. Invalid signatures, wrong audiences, incorrect ownership and revoked devices were rejected.

`scripts/live-smoke.mts` reproduces this development-only test using a temporary RSA OIDC issuer. Run it from the repository root with `apps/node/node_modules/.bin/tsx scripts/live-smoke.mts` while the local Convex development backend is running. The fixture reads the local admin key only to configure its two development authentication environment variables and restore previous values, or disable the temporary provider with empty values if they were unset; API calls use real signed user/device tokens. Signing keys stay in memory, tokens are short lived, and the issuer and Git fixture are removed afterward.

Production enrollment and a persistent identity provider remain separate work. Runtime completion does not grant integration trust: the independent verification gate remains separate.
