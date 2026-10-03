# Repository Capability Discovery

## Purpose

Zamolxis works **inside the rules of the repository it is operating on**.

Repository-local skills and instructions are first-class. Zamolxis defaults are fallback behavior, not the primary workflow definition.

This matters because repositories can legitimately differ in:

- how a task is read and updated in Linear or another tracker
- branch naming
- commit conventions
- PR creation and formatting
- draft/review policy
- labels and reviewers
- how the application is started
- test commands
- visual verification
- Figma/design workflow
- preview/deployment workflow
- architecture and coding conventions

Zamolxis must discover this context before it plans execution.

## Resolution order

```text
Repository-local skills / instructions     PRIMARY
                  ↓
Zamolxis built-in defaults                 FALLBACK
                  ↓
Runtime-native generic behavior            LAST RESORT
```

When a repository explicitly defines a capability such as `create-pr`, that repository definition wins. Zamolxis should not silently merge a conflicting built-in workflow into it.

Safety and authorization are different:

```text
Repository workflow
      ↓
Zamolxis capability / security policy
      ↓
allowed or denied
```

Repository instructions can constrain behavior but cannot grant permissions that Zamolxis policy does not allow.

## Lifecycle

Capability discovery happens after the Workspace is available and **before task planning**.

```text
Task request
    ↓
Resolve Repository
    ↓
Allocate / inspect Workspace
    ↓
Repository Capability Discovery
    ↓
Repository Context
    ↓
Supervisor planning
    ↓
Builder / Verifier / Publisher
```

Planning before repository discovery is considered incomplete because the repository may define the task lifecycle itself.

## Repository Context

Discovery produces a normalized context for the current Workspace snapshot.

```ts
RepositoryContext {
  repositoryId
  workspaceId
  gitSha

  instructions[]
  skills[]
  conventions
  discoveredSources[]

  resolvedCapabilities {
    taskTracker?
    branch?
    commit?
    pullRequest?
    testing?
    applicationRun?
    verification?
    visualVerification?
    design?
    preview?
  }
}
```

The context is tied to a Git SHA/snapshot. If repository instructions change, the context is rediscovered or invalidated.

## Discovery

Zamolxis should support repository-native instruction/skill locations through adapters rather than requiring every existing repository to immediately migrate to a Zamolxis-only format.

Discovery can inspect known repository-local sources such as:

- agent instruction files
- repository skill directories
- project-specific automation/config
- Zamolxis-specific configuration when present

Exact supported conventions belong to implementation/adapters and may grow over time.

The first implementation should not invent a large new skill DSL.

## Capability identity

Skills are resolved by semantic capability.

Examples:

```text
task-tracker
create-branch
commit
create-pr
review-pr
run-app
test
visual-verification
design-context
preview
deploy
```

A repository may have additional named skills that are passed through as repository context.

If repository skill `create-pr` exists:

```text
repo:create-pr       SELECTED
zamolxis:create-pr   fallback only
```

Do not combine both unless the repository explicitly composes them.

## Example: repository-specific PR workflow

Repository A may define:

```text
create-pr

- branch: <linear-id>-<short-name>
- title: [ABC-123] Description
- run pnpm check
- run pnpm test
- create draft PR
- include screenshots for UI changes
- link Linear issue
- move issue to In Review
```

Repository B may define:

```text
create-pr

- title: feat(scope): description
- body sections: Problem / Solution / Verification
- never create as draft
- do not assign reviewers automatically
```

Both are valid. Zamolxis follows the active repository.

## Task tracker workflow

Task creation and lifecycle are also repository-specific capabilities.

A repository skill may define:

```text
linear

Before implementation:
- fetch issue
- fetch parent/project context
- read linked design
- move issue to In Progress

After proof accepted:
- open PR using repository create-pr capability
- attach PR to issue
- move issue to In Review
```

The Supervisor uses this workflow when planning the Task.

## Role consumption

The same Repository Context is available to multiple roles, but each role consumes relevant capabilities.

```text
Repository Context
      │
      ├── Supervisor
      │     task lifecycle / planning / tracker
      │
      ├── Builder
      │     architecture / coding / run / test
      │
      ├── Verifier
      │     run / product / visual verification
      │
      └── Publisher
            branch / commit / PR / tracker update
```

Repository verification instructions inform the Verifier but do not eliminate independent verification requirements from the Trust Policy.

## Relationship with Trust

Repository skills answer **how this repository expects work to be done**.

Trust Policy answers **what evidence is required before the result can advance**.

For example:

```text
repo visual-verification skill
      ↓
teaches Verifier how to launch/navigate product
      ↓
Independent Verification
      ↓
Trust Gate evaluates resulting evidence
```

A repository cannot write a skill saying "consider every change verified" and thereby bypass the Trust Gate.

## Relationship with publishing

After Proof Accepted, publishing is a separate policy-controlled action.

```text
Proof Accepted
      ↓
Integration / Publishing Policy
      ↓
repo:create-pr
      ↓
PR opened
      ↓
human merge OR policy-controlled auto merge
```

For a human-merge repository, Zamolxis can autonomously finish implementation, verification and PR creation while leaving merge to the human.

## Security invariants

1. Repository-local workflow has precedence over Zamolxis workflow defaults.
2. Repository instructions never increase granted OS/cloud/provider permissions.
3. Repository skills cannot bypass Trust Gate.
4. Repository skills cannot override protected-branch/integration policy.
5. Capability discovery is tied to the Workspace/Git snapshot.
6. Untrusted repository instructions are treated as code/config from that repository, not as system authority.
7. Conflicting repo capability definitions produce an explicit resolution error rather than arbitrary selection.

## v0.1 scope

Implement only what is required for reliable repo-first behavior:

- discover repository-local instructions/skills
- normalize them into Repository Context
- resolve repo capability before Zamolxis fallback
- expose context to Supervisor, Builder and Verifier
- bind context to Workspace SHA
- record selected capability/source in Trace
- enforce security/policy after capability resolution

Do not build a marketplace, organization-wide skill registry, skill recommendation engine or elaborate skill language in v0.1.
