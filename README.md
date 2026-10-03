# Zamolxis

**Local-first control plane and orchestration system for autonomous coding agents.**

Zamolxis coordinates durable Work Sessions across local workstations while native coding runtimes execute inside isolated local Git workspaces.

## Architecture

```text
                       Web / Mobile
                           |
                           v
                  Cloud Control Plane
                Convex + Supervisor/Workflow
                           |
                   typed commands/events
                    /                 \
                   v                   v
             Zamolxis Node       Zamolxis Node
                   |                   |
          Workspace Manager     Workspace Manager
                   |                   |
            Runtime Registry     Runtime Registry
             /    |    \          /    |    \
          Codex Claude Hermes  Codex Claude Hermes
```

Core execution hierarchy:

```text
Product -> Repository -> Work Session -> Task -> Workspace -> Agent Run -> Runtime
```

A Workspace belongs to Zamolxis, not to a runtime. A failed runtime may be replaced while preserving the same isolated worktree.

## Repository structure

```text
apps/
  web/            Next.js operator UI
  node/           local Zamolxis Node executable

packages/
  domain/         pure business rules
  application/    use cases and ports
  contracts/      DTOs / command-event protocol
  ui/             reusable shadcn-based product UI
  lib/            shared technical library wrappers
  git/            Git/worktree infrastructure
  node-core/      local Node application logic
  runtime-core/   runtime contract and normalized model
  runtime-codex/
  runtime-claude/
  runtime-hermes/
  supervisor/
  test-kit/

convex/            thin cloud delivery/persistence adapter
```

Dependency direction is inward toward domain/application. Domain code must not import Convex, Next.js, Git CLI, native process APIs or runtime-specific packages.

## Engineering plan

See [PROJECT.md](PROJECT.md) and GitHub Issues.

Detailed architecture/build specifications currently live in the companion `zamolxis-docs` repository.

## Status

Pre-alpha / architecture and foundation.
