# Runtime adapter contract v0.1

Runtime selection is separate from model selection. An AgentRuntime advertises capabilities and implements start/resume/send/stop/inspect plus normalized event subscription. Workspace assignment comes from the Node; runtimes cannot choose repository paths.

RuntimeRegistry chooses only allowed adapters satisfying required capabilities. Forced selection never falls back; preferred selection may use another eligible adapter. Domain/application code does not branch on vendor names.

FakeRuntime is an in-memory deterministic adapter with configurable activity, waiting, approval, success and failure steps. A waiting scenario continues on message/resume, an approval step holds the scenario until `resolveApproval` (a message does not settle it), and stop is idempotent. Repeated start for the same Run returns the same session; conflicting workspace assignment or instruction is rejected. Snapshots are defensive copies and replay uses stable ordered event IDs.

The fake does not execute shell commands or mutate files. Its assigned cwd is metadata validated by the Node's Workspace Manager before runtime launch. In-memory fake sessions cannot survive a Node process restart; reconciliation must mark an unrecoverable session lost rather than silently start it again.

`@zamolxis/test-kit/runtime-contract` exports `defineRuntimeAdapterContract` for future Codex/Claude/Hermes adapters. Each adapter supplies a controlled factory and a workspace-bound input. The suite checks advertised identity, assignment preservation, idempotent starts, event provenance/replay and rejection of changed workspace assignment. Adapter-specific tests cover waiting/message/resume/stop semantics.

## Approvals

An adapter that can hold an operation for a human advertises `canApprove` and implements `resolveApproval({ nativeSessionId, approvalId, decision: "approve" | "reject" })`. It emits `approval.requested { approvalId, kind: command | fileChange | tool | other, summary (≤2000 characters, human readable), risk: low | medium | high | critical }`; the id is stable (`<runId>:<runtime request id>`). Risk is conservative (`classifyCommandRisk` in runtime-core): anything touching credentials, privilege or paths outside the workspace is critical, network, deletion or history rewriting high. Risk is display only: every held operation needs an explicit decision, and nothing is ever auto-approved.

Every settlement emits `approval.resolved { approvalId, decision: approved | rejected, reason: user | timeout | stopped | withdrawn }`. Stop and any terminal state reject every pending approval before the terminal event; resolving an unknown or settled approval throws `APPROVAL_NOT_PENDING`. `defineRuntimeApprovalContract` in `@zamolxis/test-kit/runtime-contract` checks these rules; FakeRuntime and CodexRuntime pass it.

The Node delivers approval events immediately (not with the next batch), the backend creates an `approvals` row and holds the run in `needs_approval`; `approvals.resolve` (owner only, idempotent) enqueues `runtime.approval` for the run's Node, which executes it through `driver.control()` even while `tick()` streams the run. The runtime's `approval.resolved` returns the run to `running`. Read-only roles never hold approvals: Codex refuses them for Verifier and Supervisor runs and the Node rejects any Supervisor request.

## Messages (steering)

`runtime.send` delivers a message to a run. For a run another command is streaming, the Node calls `send` and completes the command; the streaming command reports what follows. For a run that paused (`run.waiting`, or a non-blocking adapter after an approval request), the message command follows the run until it pauses again and, when it ends, completes it exactly like `runtime.start` (final summary, candidate commit for builder/repair, deterministic checks for a verifier). The Node advertises the `message` capability and `runs.sendMessage` requires it. A message or approval command interrupted by a Node restart fails with `RUNTIME_COMMAND_INTERRUPTED`; the run itself is reconciled through its start command.
