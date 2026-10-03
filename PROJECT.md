# Engineering Project Map

GitHub Issues are the executable backlog. Epic issues describe capabilities; implementation issues describe reviewable work.

## Epics

| Epic | Capability |
|---|---|
| #1 | Foundation & architecture |
| #2 | Control Plane / Convex |
| #3 | Local Node / Git Workspaces |
| #4 | Runtime system / Codex |
| #5 | Realtime operator UI |
| #6 | Durable orchestration / Supervisor |
| #7 | Claude & Hermes |
| #8 | Integration / parallel coding |
| #9 | Security / approvals / hardening |

## Critical path

```text
#10 Monorepo
  |
  +--> #11 Contracts
  |       +--> #12 Convex schema
  |       '--> #15 Local durable state
  |
  '--> #13 Domain state machines --> #14 API

#15 -> #16 Repository Registry -> #17 Worktree Manager
                                      |
#11 -------------------------------> #18 Fake Runtime
                                      |
                    #14 + #17 + #18
                           |
                           v
                 #19 First vertical slice
                    /             \
                   v               v
             #20 Codex         #22 Operator UI
                                ^
                                |
                              #21 Shell
                                |
                                v
                              #23 Graph
```

## First proof

The architecture is first proven when #19 succeeds:

```text
Control Plane
 -> Node
 -> isolated Git Workspace
 -> Fake Runtime
 -> normalized events
 -> Control Plane
```

This proves command delivery, workspace safety, idempotency, event ingestion and recovery independently of vendor runtime behavior.

## Issue standard

Implementation issues should contain Goal, Scope, dependencies, acceptance criteria and parent Epic. Prefer capability-oriented issues over layer-oriented chores.

## Pull request standard

A PR should reference its issue, preserve package dependency boundaries, include tests for new domain/application behavior, avoid unrelated refactors, and document architectural decisions that change public contracts.

## Architecture rule

A human engineer should be able to trace a behavior as:

```text
delivery boundary -> application use case -> domain rule -> port -> infrastructure adapter
```

If understanding a feature requires following helper layers with no clear responsibility, simplify the code.
