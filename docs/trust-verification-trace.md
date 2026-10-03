# Trust, Independent Verification & Execution Trace Architecture

## Purpose

Zamolxis is autonomous by default.

The normal path is not "agent works, human approves." It is:

```text
User Intent
    ↓
Acceptance Contract
    ↓
Implementation Run
    ↓
Candidate
    ↓
Independent Verification
    ↓
Trust Decision
    ↓
Policy allows?
    ├─ yes → integrate automatically
    └─ no  → repair / escalate
```

A human may inspect, reproduce, challenge or override within policy, but routine successful work should not require human participation.

Trust is not based on an agent saying it finished, nor on tests written by the same agent merely passing.

## Threat model: self-confirming agents

An implementation agent can accidentally or deliberately produce weak evidence:

- write a test that matches its implementation instead of the user intent
- omit important edge cases
- mock away the behavior being changed
- change tests to make a regression appear valid
- claim a command passed without independently reproducing it
- satisfy unit tests while the real UI is visually broken
- satisfy DOM assertions while interaction is unusable
- produce screenshots that do not exercise the requested behavior

Therefore builder-produced tests, logs and artifacts are **candidate evidence**, not sufficient proof by themselves.

## Separation of roles

```text
                    Acceptance Contract
                           │
               ┌───────────┴───────────┐
               ▼                       ▼
       Implementation Run        Verification Plan
               │                       │
               ▼                       │
            Candidate ─────────────────┤
                                       ▼
                             Independent Verifier
                                       │
                   ┌───────────────────┼───────────────────┐
                   ▼                   ▼                   ▼
              deterministic        black-box          visual/product
                 checks             probes             observation
                   │                   │                   │
                   └───────────────────┼───────────────────┘
                                       ▼
                                 Evidence Bundle
                                       │
                                       ▼
                                   Trust Gate
                                       │
                                 auto integrate
```

Implementation and verification are different Runs with different responsibilities.

For higher-risk work, policy may require a different model/runtime/context for verification.

## Acceptance Contract

Verification begins from user intent, not from the implementation.

Before or during planning Zamolxis derives an explicit Acceptance Contract:

```ts
AcceptanceContract {
  goal
  observableOutcomes[]
  constraints[]
  forbiddenRegressions[]
  references[]
  riskHints[]
}
```

Example:

```text
Goal:
Mobile sidebar behaves as a drawer.

Observable outcomes:
- desktop navigation remains visible at desktop breakpoint
- phone navigation is hidden until invoked
- tapping menu opens a usable drawer
- selecting destination closes/navigates correctly
- content does not horizontally overflow

Constraints:
- use Zamolxis Design System
- keyboard interaction remains functional
```

The Builder may clarify the contract, but cannot silently weaken required outcomes after implementation starts.

## Verification independence

Verifier input should prefer:

1. Acceptance Contract
2. Candidate Workspace/SHA
3. repository/product verification capabilities
4. relevant design/API references
5. risk policy

It should not depend on the Builder's explanation of how the feature was implemented.

For appropriate tasks, some verifier probes may be generated independently or hidden from the Builder so implementation cannot simply optimize for known checks.

## Verification modalities

Verification is multimodal. Required modalities depend on the task.

### Deterministic / structural

Examples:

- typecheck
- lint
- architecture boundaries
- build
- dependency policy
- schema compatibility
- static/security analysis

These are useful constraints but do not prove product correctness.

### Test execution

Repository tests are re-run independently.

Builder-written tests are treated as one signal. The Verifier may inspect test quality, generate additional tests, execute existing unaffected suites and challenge assumptions.

### Black-box behavioral verification

Prefer externally observable behavior where possible:

- browser interaction
- HTTP/API calls
- CLI behavior
- database state transitions
- file outputs
- process behavior
- reconnect/retry/recovery flows

The Verifier should exercise the product without relying on implementation internals when practical.

### Visual verification

Visual work requires visual evidence.

For frontend changes the Verifier can:

1. launch the actual application
2. navigate to the affected surface
3. render required viewports/states
4. interact with the UI
5. capture screenshots/recording
6. compare against reference/design/previous state when available
7. use vision reasoning to detect layout, clipping, overlap, hierarchy, responsive and obvious visual regressions

A green component/unit test cannot substitute for required visual verification.

### Interaction verification

UI verification should test interaction, not screenshots alone:

- click/tap
- keyboard/focus
- scrolling
- opening/closing overlays
- form entry
- loading/error/empty states
- navigation
- responsive transitions

### Adversarial / mutation verification

When justified, the Verifier may challenge the evidence:

- generate edge cases independently
- fuzz inputs
- mutate implementation or conditions
- disable/remove a critical condition and verify tests detect it
- alter response/error timing
- test degraded network/service behavior

Mutation is evidence about **test sensitivity**: if an important defect can be introduced while the verification remains green, confidence in that verification is reduced.

## Verification Plan

```ts
VerificationPlan {
  contractId
  requiredModalities[]
  requiredChecks[]
  independentProbes[]
  optionalChecks[]
  escalationPolicy
}
```

The plan is assembled from:

- repository baseline
- Acceptance Contract
- task class
- changed surface
- risk/blast radius
- product feature map
- available verifier capabilities

Implementation agents may add checks. They cannot remove policy-required verification.

## Product / Feature Map

Repositories can expose a versioned Product Verification Map describing how to exercise real product surfaces.

```text
Feature: session-composer
route: /sessions/:id
setup: seeded session
states:
  - idle
  - submitting
  - running
  - stopped
viewports:
  - 1440x900
  - 390x844
critical interactions:
  - type prompt
  - submit
  - stop
  - reopen session
```

This is not a fixed test implementation. It teaches independent verifiers how to reach and observe the product.

Feature Maps/verification skills require their own evals and versioning; a broken verifier is itself a trust risk.

## Execution Trace

Every Run produces an append-only normalized Trace independent of native runtime.

```ts
ExecutionTrace {
  traceId
  sessionId
  taskId
  runId
  role: "builder" | "verifier" | "repairer"
  workspaceId
  runtime
  startedAt
  finishedAt?
  steps[]
  artifacts[]
}
```

Semantic TraceSteps include:

```text
FileRead
FileChanged
CommandStarted
CommandCompleted
TestRun
BuildRun
BrowserAction
VisualCapture
ApiProbe
MutationProbe
GitOperation
AgentMessage
VerificationFinding
TrustDecision
```

Private chain-of-thought is never stored or required. A short externally useful activity summary is allowed.

## Provenance

Evidence and Trace steps record provenance:

- Run and role
- Workstation
- Runtime/model where available
- native session
- Workspace
- Git SHA/snapshot
- verifier/check version
- command/probe
- timestamp
- artifacts/result

This lets a human answer: **what actually happened, where, against which code, and who/what observed it?**

## Evidence quality

Evidence has origin and modality, not merely pass/fail.

```ts
Evidence {
  origin: "builder" | "independent-verifier" | "deterministic-system" | "human"
  modality: "static" | "test" | "behavioral" | "visual" | "interaction" | "mutation" | "security"
  subjectSha
  result
  artifacts[]
  reproducible
}
```

Trust Policy may require independent evidence for specific modalities.

Builder evidence can support a decision but cannot masquerade as independent verification.

## Evidence freshness

Evidence belongs to an exact Workspace/Git state.

```text
verified SHA: abc123
agent changes code
current SHA: def456

abc123 evidence != proof for def456
```

Relevant verification must be rerun.

## Trust Gate

The Trust Gate is deterministic application/domain policy.

Inputs:

```text
Acceptance Contract
Task/Risk classification
Candidate SHA
Verification Plan
Independent Verification Runs
Evidence modalities + provenance
Repository policy
Historical outcomes
```

Output:

```ts
TrustDecision {
  decision:
    | "repair_required"
    | "insufficient_evidence"
    | "human_escalation"
    | "eligible_for_integration"

  reasons[]
  satisfiedRequirements[]
  missingRequirements[]
}
```

No opaque LLM confidence score grants integration.

The LLM/vision verifier may produce findings. Policy decides whether the required independent evidence exists.

## Autonomous repair loop

Failure normally goes back to agents, not immediately to the human.

```text
Builder
   ↓
Verifier
   ↓ fail
Repair Run
   ↓
Verifier (fresh)
   ↓
Trust Gate
```

The loop has budgets/limits to avoid infinite autonomous repair.

Human escalation happens when policy requires it or autonomous attempts cannot establish sufficient evidence.

## Autonomy

Human approval is **not** the default Trust Gate requirement.

Typical successful path:

```text
Implement
   ↓
independently verify
   ↓
sufficient evidence
   ↓
auto integrate
```

Human involvement may be mandatory for explicitly high-risk classes or triggered by uncertainty/failure.

Historical performance can influence permitted autonomy, but cannot override hard repository safety rules.

## Human inspection and challenge

Even when Zamolxis auto-integrates, proof remains inspectable.

The user can:

- inspect Acceptance Contract
- inspect Builder Trace
- inspect independent Verifier Trace
- view exact commands/results
- view screenshots/recordings
- inspect black-box probes
- inspect mutation results
- inspect diff and Workspace SHA
- re-run verification
- mark "I disagree"
- create a repair/revert task

Human review is therefore **available**, not structurally required for routine work.

## UI

Trust is visible throughout the product without dominating Conversation.

### Conversation card

```text
Authentication redirect                         Integrated

✓ Implemented
✓ Independently verified
✓ Behavioral verification
✓ Visual verification
✓ Policy checks

Integrated automatically

[ Inspect proof ]
```

Do not label a Task simply "Verified" because Builder tests passed.

### Verification / Proof inspector

```text
PROOF

Acceptance
✓ Redirect returns user to /reports
✓ Mobile layout remains usable

Independent verification
✓ Browser behavior             12 probes
✓ Visual                       2 viewports
✓ Interaction                  keyboard + pointer
✓ Repository tests             84 passed
✓ Build
✓ Architecture

Evidence quality
Independent modalities: 5
Builder-only evidence:   2

Candidate
SHA abc123

Trust decision
ELIGIBLE FOR INTEGRATION
Policy: low-risk application change

[ View trace ] [ Re-run verification ] [ I disagree ]
```

### Visual proof

```text
VISUAL VERIFICATION

Desktop 1440×900
[ screenshot ]

Mobile 390×844
[ screenshot ]

Interaction
[ recording ]

Verifier findings
✓ no horizontal overflow
✓ drawer opens/closes
✓ content hierarchy intact
✓ keyboard interaction works
```

### Trace viewer

Builder and Verifier traces are visibly separate:

```text
TRACE

Builder
14:02 changed callback handler
14:05 added tests
14:07 tests passed

Independent verifier
14:09 launched application
14:10 exercised login
14:11 tested expired session
14:12 mobile visual capture
14:13 mutation probe
14:14 verification passed

Trust Gate
14:14 eligible for automatic integration

Integration
14:15 integrated
```

### Mobile

Conversation remains primary. Proof opens as a full-height Sheet with compact acceptance, verification modalities, visual artifacts, Trust Decision and actions:

```text
[Re-run] [I disagree]
```

Manual verification is available when the user wants it, but routine success does not wait for it.

## Backend boundaries

### Supervisor

- plans work and Acceptance Contract
- may request verification
- cannot grant trust to its own result
- cannot waive hard policy

### Builder Runtime

- implements Candidate
- can produce candidate evidence
- cannot classify its evidence as independent

### Verifier

- receives Acceptance Contract + Candidate
- independently probes product/result
- produces findings/evidence
- does not grant integration permission

### Trust Engine

- deterministic policy
- evaluates evidence provenance/modalities/freshness/risk
- grants or denies integration eligibility

### Integration workflow

- checks Trust Decision server-side
- verifies decision applies to exact Candidate SHA
- refuses stale/bypassed decisions

## Required invariants

1. Implementation completion != verification.
2. Builder-produced tests are not sufficient independent proof.
3. Visual acceptance requires visual/product observation when policy says it matters.
4. Behavioral acceptance prefers black-box observation.
5. Evidence records provenance and exact Candidate SHA.
6. Changed Candidate invalidates affected evidence.
7. Verifier and Builder roles are distinguishable in data and UI.
8. Trust Gate is deterministic and server-side.
9. Routine successful work can auto-integrate without human action.
10. Human can inspect and re-run proof after or before integration.
11. Private chain-of-thought is never required.
12. Failed independent verification normally enters autonomous repair before human escalation.
