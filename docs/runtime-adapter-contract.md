# Runtime adapter contract v0.1

Runtime selection is separate from model selection. An AgentRuntime advertises capabilities and implements start/resume/send/stop/inspect plus normalized event subscription. Workspace assignment comes from the Node; runtimes cannot choose repository paths.

RuntimeRegistry chooses only allowed adapters satisfying required capabilities. Forced selection never falls back; preferred selection may use another eligible adapter. Domain/application code does not branch on vendor names.

FakeRuntime is an in-memory deterministic adapter with configurable activity, waiting, approval, success and failure steps. A waiting scenario continues on a message, an approval step holds the scenario until `resolveApproval` (a message does not settle it), and stop is idempotent. Repeated start for the same Run returns the same session; conflicting workspace assignment or instruction is rejected. Snapshots are defensive copies and replay uses stable ordered event IDs.

The fake does not execute shell commands or mutate files. Its assigned cwd is metadata validated by the Node's Workspace Manager before runtime launch. Fake sessions survive a simulated restart only through a shared `FakeNativeStore` (the stand-in for Codex rollouts); without it a new instance cannot resume them and the Node reports the run lost rather than starting it again.

`@zamolxis/test-kit/runtime-contract` exports `defineRuntimeAdapterContract` for future Codex/Claude/Hermes adapters. Each adapter supplies a controlled factory and a workspace-bound input. The suite checks advertised identity, assignment preservation, idempotent starts, event provenance/replay and rejection of changed workspace assignment. Adapter-specific tests cover waiting/message/resume/stop semantics.

## Approvals

An adapter that can hold an operation for a human advertises `canApprove` and implements `resolveApproval({ nativeSessionId, approvalId, decision: "approve" | "reject" })`. It emits `approval.requested { approvalId, kind: command | fileChange | tool | other, summary (≤2000 characters, human readable), risk: low | medium | high | critical }`; the id is stable (`<runId>:<runtime request id>`). Risk is conservative (`classifyCommandRisk` in runtime-core): anything touching credentials, privilege or paths outside the workspace is critical, network, deletion or history rewriting high. Risk is display only: every held operation needs an explicit decision, and nothing is ever auto-approved.

Every settlement emits `approval.resolved { approvalId, decision: approved | rejected, reason: user | timeout | stopped | withdrawn }`. Stop and any terminal state reject every pending approval before the terminal event; resolving an unknown or settled approval throws `APPROVAL_NOT_PENDING`. `defineRuntimeApprovalContract` in `@zamolxis/test-kit/runtime-contract` checks these rules; FakeRuntime and CodexRuntime pass it.

The Node delivers approval events immediately (not with the next batch), the backend creates an `approvals` row and holds the run in `needs_approval`; `approvals.resolve` (owner only, idempotent) enqueues `runtime.approval` for the run's Node, which executes it through `driver.control()` even while `tick()` streams the run. The runtime's `approval.resolved` returns the run to `running`. Read-only roles never hold approvals: Codex refuses them for Verifier and Supervisor runs and the Node rejects any Supervisor request.

## Messages (steering)

`runtime.send` delivers a message to a run. For a run another command is streaming, the Node calls `send` and completes the command; the streaming command reports what follows. For a run that paused (`run.waiting`, or a non-blocking adapter after an approval request), the message command follows the run until it pauses again and, when it ends, completes it exactly like `runtime.start` (final summary, candidate commit for builder/repair, deterministic checks for a verifier). The Node advertises the `message` capability and `runs.sendMessage` requires it. A message or approval command interrupted by a Node restart fails with `RUNTIME_COMMAND_INTERRUPTED`; the run itself is recovered (below).

## Resume after a Node restart

`resume(input)` reattaches a run to its native session. In the process that runs it, it is a no-op returning the snapshot. In a new process it rebuilds the session from what the runtime persisted, using what the Node recorded (`ResumeRunInput`):

- `afterSequence`: the last event sequence in the Node's durable outbox; resumed events continue after it with identities never used before, so nothing is delivered twice;
- `announce`: emit `run.started` first (the control plane never saw it, or reported the run lost);
- `pendingApprovalIds`: approvals requested and not settled before the restart; each is reported `approval.resolved` rejected with reason `withdrawn` before anything else. A restart never approves anything; the agent must ask again, under a new approval id;
- `interrupted`: what to do with a turn the restart interrupted: `continue` (a new turn on the same native session continues the original task), `fail` (`run.failed`, code `NODE_RESTART_INTERRUPTED`) or `stop` (`run.stopped`);
- `usage`: usage already reported, so resumed totals never decrease.

A session that is unknown, assigned to another workspace, or possibly still running elsewhere is never started again: resume throws (RECONCILIATION_REQUIRED for uncertainty). `defineRuntimeResumeContract` in `@zamolxis/test-kit/runtime-contract` checks these rules with two runtime instances sharing native state; FakeRuntime and CodexRuntime pass it.

On its first tick a new Node process recovers every run a previous process left unfinished: runtime sessions not known to be terminal (Supervisor runs excluded) and runs whose `runtime.start` command was interrupted. Sessions the current process already runs are skipped. For each run, in the background:

1. `node:reconcile(runId, "resuming")` returns the control plane's status without changing it. If the control plane is unreachable, the run is tried again on a later tick.
2. If the outbox already holds the run's terminal event, the run is completed from it (candidate commit, checks, final summary) without the runtime.
3. Otherwise `RuntimeManager.resume` takes over the run's workspace lease from the previous Node instance (never one held for another run) and calls `runtime.resume` with the cursor, pending approvals and usage from the outbox, `announce` when nothing was recorded or the run is `lost` or `starting`, and the policy: `stop` when a stop is pending or the run is `stopping`; otherwise `continue` for at most `MAX_RESTART_CONTINUATIONS` (2) recoveries per run (counted in `runtime_sessions.recoveries`), then `fail`.
4. The run is followed and completed exactly like `runtime.start`, and the interrupted start command completes with it. Stop, message and approval commands for the run wait until its session is back; a stop interrupted by the restart is acknowledged once the run's outcome is recorded. A trace step "Resumed after a Node restart" (or "Could not resume after a Node restart") is recorded.
5. If anything fails, events already observed are still delivered and the run is reported with `node:reconcile(runId, "missing", <code>)`: it becomes `lost` with the code in `exitReason`, its approvals expire, and it keeps its workspace and capacity until reconciled. Its start command stays open on the Node and is retried at the next Node start; the command queue is never blocked. A later successful recovery moves the run from `lost` back to `running`.

The current instance of a Node may fail a command an earlier instance of the same Node claimed (`node:failCommand`), so interrupted plans, messages and approvals are reported after a restart instead of blocking the outbox. Tests: `packages/node-core/src/control-plane/restart-recovery.test.ts` (new driver, store and runtime instances over the same state file) and `tests/restart-recovery.test.ts` (end to end through Convex, plus the opt-in real Codex restart acceptance).
