# Trust, Verification & Execution Trace Architecture

## Principle

Zamolxis does not trust an agent because the agent says it is done.

Every meaningful result moves through a verifiable pipeline:

```text
Intent
  ↓
Plan
  ↓
Task
  ↓
Agent Run
  ↓
Execution Trace
  ↓
Verification Run(s)
  ↓
Evidence Bundle
  ↓
Trust Gate
  ├─ rejected
  ├─ human verification required
  └─ eligible for integration
```

Trust is an outcome of evidence and policy, not an LLM confidence score.

## Execution Trace

Every Agent Run produces an append-only normalized trace independent of the native runtime.

```ts
ExecutionTrace {
  traceId
  sessionId
  taskId
  runId
  workspaceId
  runtime
  startedAt
  finishedAt?

  steps: TraceStep[]
  artifacts: TraceArtifact[]
  verificationRuns: VerificationRun[]
}
```

A TraceStep is semantic, not merely raw stdout:

```ts
TraceStep =
  | ThoughtSummary
  | FileRead
  | FileChanged
  | CommandStarted
  | CommandCompleted
  | TestRun
  | BuildRun
  | BrowserAction
  | GitOperation
  | AgentMessage
  | ApprovalRequested
  | VerificationResult
```

Private chain-of-thought is never required or stored. ThoughtSummary means a short externally useful explanation such as "Inspecting authentication middleware", not hidden reasoning.

Native runtime logs may be retained separately for diagnostics. Product UI consumes normalized TraceSteps.

## Trace provenance

Every step records provenance where applicable:

```ts
TraceStep {
  stepId
  sequence
  type
  timestamp
  source: {
    workstationId
    runtime
    nativeSessionId?
    processId?
  }

  commandId?
  exitCode?
  workspaceSnapshotId?
  artifactIds?
}
```

This allows Zamolxis to answer:

- who/what performed this action?
- in which Workspace?
- against which repository state?
- what was the result?
- what evidence was produced?

## Verification Plan

A Task receives a Verification Plan before it is eligible for completion.

```ts
VerificationPlan {
  required: VerificationCheck[]
  optional: VerificationCheck[]
  humanChecks: HumanVerificationCheck[]
}
```

Checks are declarative.

Examples:

```text
typecheck
lint
unit-tests
integration-tests
build
architecture-boundaries
git-diff-policy
browser-smoke
visual-proof
api-contract
custom-command
human-product-check
```

The agent cannot silently redefine required checks after implementation.

## Verification Run

Verification is separate from Agent Run.

```ts
VerificationRun {
  verificationRunId
  taskId
  workspaceId
  checkId
  executor
  startedAt
  finishedAt
  status
  command?
  exitCode?
  evidenceArtifactIds[]
}
```

An implementation agent saying "tests pass" is not evidence. Zamolxis runs or observes the verification and records the result.

## Evidence Bundle

Evidence is first-class and inspectable.

```ts
EvidenceBundle {
  bundleId
  taskId
  runId
  workspaceSnapshot
  changedFiles
  diffSummary
  checks
  artifacts
  humanVerification
}
```

Possible artifacts:

- command output
- test report
- coverage report
- build output
- screenshots
- browser recording
- generated preview URL
- API response
- diff/patch
- Git commit
- structured runtime log

Artifacts should be reproducible where practical and linked to the exact Workspace snapshot/SHA they verified.

## Reproducibility

A verification check may expose a Re-run action.

```text
Verification Check
  command: pnpm test
  cwd: workspace root
  env profile: test
  workspace SHA: abc123
  result: PASS

  [View output] [Re-run]
```

Re-running creates a new VerificationRun. Historical evidence is never overwritten.

## Manual verification

Some product behavior cannot or should not initially be auto-approved.

Human verification is modeled explicitly:

```ts
HumanVerification {
  checkId
  instructions
  expectedResult
  evidenceToInspect[]
  decision?: "passed" | "rejected"
  decidedBy?
  decidedAt?
  note?
}
```

Example:

```text
MANUAL CHECK

Authentication redirect

Expected:
After signing in, user returns to /reports.

Evidence:
[Open preview]
[View browser recording]
[View changed files]

Steps:
1. Open preview
2. Sign in with test account
3. Confirm /reports loads

[Reject] [Request changes] [Mark verified]
```

A human decision is itself appended to the Trace.

## Trust Gate

Trust Gate is deterministic policy evaluation.

Inputs:

```text
Task risk
Repository policy
Verification Plan
Verification Runs
Evidence Bundle
Human verification decisions
Workspace/Git state
Runtime history (optional contextual signal)
```

Output:

```ts
TrustDecision {
  decision:
    | "verification_failed"
    | "human_required"
    | "eligible_for_integration"
    | "blocked"

  reasons[]
  satisfiedChecks[]
  missingChecks[]
}
```

No opaque LLM-generated trust score controls integration.

## Risk / autonomy

Policy may classify work by blast radius:

```text
LOW
copy, styling, isolated refactor

MEDIUM
application behavior, API changes, dependencies

HIGH
auth, permissions, billing, migrations,
deployment, infrastructure, destructive operations
```

Higher risk requires stronger evidence and/or human verification.

Historical success may increase permitted autonomy for a task class, but it never overrides explicit repository safety policy.

## Trust feedback loop

Human rejection should improve the system.

```text
Human rejection
      ↓
Failure classification
      ├─ missing test
      ├─ missing verifier
      ├─ architecture rule
      ├─ skill/instruction gap
      └─ runtime failure
      ↓
Guard / verifier / skill / eval
      ↓
Future Verification Plans
```

Repeated review comments should become executable constraints where possible.

# UI

Trust is visible, not hidden in Settings.

## Conversation

Agent/Task cards show compact verification state:

```text
API implementation                       Done

7 files changed
Verification  5/6 passed

✓ Typecheck
✓ Unit tests
✓ Integration tests
✓ Architecture
✓ Build
○ Manual product check

[Review evidence]
```

"Done" for execution and "Verified" are visually distinct states.

## Session Inspector

Add a first-class **Verification** tab alongside Tasks, Agents, Activity, Changes and Context.

```text
INSPECTOR

Tasks
Agents
Activity
Changes
Verification  ←
Context
```

## Verification panel

```text
VERIFICATION

Task: Authentication redirect

AUTOMATED
✓ Typecheck                    2.1s
✓ Lint                         1.4s
✓ Unit tests                  18.2s
✓ Build                       31.7s
✓ Architecture boundaries     0.4s

PRODUCT
○ Redirect behavior       Needs you

EVIDENCE
  4 files changed
  workspace @ abc123
  browser recording
  test output

[Re-run checks]
[Open workspace evidence]

Trust Gate
Human verification required
```

## Trace viewer

Activity evolves into an inspectable execution trace:

```text
TRACE

14:02  Agent started
14:03  Read auth middleware
14:05  Changed callback handler
14:07  pnpm test
       ✓ 84 passed
14:08  pnpm build
       ✓ exit 0
14:09  Browser verification
       artifact: recording
14:10  Waiting for manual verification
```

Each row can reveal provenance, command output, files/artifacts and workspace snapshot.

## Mobile

Conversation remains primary.

Task card shows a compact trust state. Tapping it opens a full-height Verification Sheet:

```text
Authentication redirect

Verification 5/6

✓ Tests
✓ Build
✓ Lint
○ Manual check

[Open preview]

Expected:
Sign in returns to /reports.

[Reject] [Verified]
```

A user must be able to manually verify and approve/reject from a phone.

## State model

Task completion is not enough for integration.

```text
IMPLEMENTING
   ↓
IMPLEMENTED
   ↓
VERIFYING
   ├── FAILED ──→ needs work
   ↓
AWAITING_HUMAN
   ↓
VERIFIED
   ↓
INTEGRATION_READY
   ↓
INTEGRATED
```

Not every Task needs every state, but integration always requires a satisfied Trust Gate.

## Backend responsibilities

Control Plane:
- stores Verification Plans
- stores normalized Trace metadata
- stores Evidence metadata
- evaluates Trust Policy
- records human decisions
- controls integration eligibility

Zamolxis Node:
- captures local execution provenance
- executes deterministic verification commands
- produces artifacts
- snapshots Workspace/Git state
- uploads normalized events/evidence metadata
- never grants itself integration permission

Runtime Adapter:
- translates native runtime activity into normalized TraceSteps
- exposes native session provenance
- does not decide trust

Supervisor:
- may propose Verification Plan additions
- may request human verification
- cannot waive mandatory policy checks

## Invariants

1. Agent completion does not imply verification.
2. Evidence belongs to a specific Workspace state/SHA.
3. Re-runs append; they do not rewrite history.
4. Human decisions are auditable Trace events.
5. Runtime adapters cannot grant trust.
6. Supervisor cannot bypass mandatory checks.
7. Integration checks Trust Gate server-side.
8. Manual verification is a first-class workflow, not a comment.
9. Private chain-of-thought is never a trust requirement.
10. UI always distinguishes running, implemented, verifying, needs-human, verified and integrated.
