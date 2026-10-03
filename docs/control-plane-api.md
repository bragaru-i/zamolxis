# Control-plane API v0.1

Convex owns Session, Task, Workspace, Run and command state. Public user functions require an authenticated profile and enforce ownership on every resource. Node functions require a separately registered device token whose signed `ownerSubject` matches its owner's token identifier. Tokens are verified by the configured OIDC issuer; a caller cannot supply this claim as a mutation argument. Revoked devices are rejected.

Set `ZAMOLXIS_AUTH_ISSUER` and `ZAMOLXIS_AUTH_AUDIENCE` on the development deployment before using the API. The issuer must issue distinct user and device subjects and bind the device's owner claim during trusted enrollment. An empty provider configuration accepts no identities. This change does not implement an identity provider or device token minting.

The API exposes bounded reads, workspace provisioning requests and typed runtime start/message/stop commands. It does not expose arbitrary shell execution, patches or force-trust. Queued cancellation expires the pending start and releases cloud ownership; active cancellation waits for a confirmed terminal snapshot. Missing native sessions become lost and retain ownership until reconciliation.

Task dependency edges point from newly created tasks to existing tasks, preventing cycles. Completed prerequisites unblock eligible tasks. Event batches are ordered, transactional and deduplicated by stable event identity, with conflicting retries rejected. A terminal event is separate from a final workspace snapshot; only the latter settles counters and releases cloud ownership.

Verification links are internal-only. A verifier must have a distinct Run and Workspace based on the completed builder SHA. Evidence must come from that verifier's authenticated Node and a clean, completed snapshot at the subject SHA. Trust requires independent static and behavioral evidence; failed evidence or changed snapshots block eligibility. Human approval records permission and cannot bypass the evidence gate. Eligibility is not a merge operation; future integration must re-evaluate the exact SHA immediately before acting.

Local verification uses `convex-test`; it does not prove live deployment or identity-provider configuration. `pnpm codegen:convex` generates schema-derived types locally from the installed official Convex templates, without contacting a backend. The script fails if those template boundaries change. Standard Convex deployment/codegen remains the live verification path.
