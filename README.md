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

## Identity, PWA and Node security

The public UI is a PWA served from one configured canonical HTTPS origin (`ZAMOLXIS_APP_URL`). Human identity and local Node identity are deliberately separate. A human authenticates through the configured OIDC provider; a Mac is enrolled only after an authenticated user approves a short-lived, single-use QR pairing request.

The QR points to the canonical PWA origin. OAuth callbacks, post-login redirects and bootstrap metadata use that same configured origin rather than trusting an incoming Host header or a preview deployment URL. The Mac makes outbound connections to the control plane; Zamolxis does not require a public inbound port on the workstation.

Authorization is server-side: authenticated ownership binds Products, Repositories, Work Sessions and Workstations. A paired Node receives a Node-scoped credential and can be revoked independently from human browser sessions.

## Agent roles and trust

The intended execution model separates the human-facing Supervisor from repository executors. Builder Runs create candidate changes in isolated worktrees. Verifier Runs are independent and produce evidence for an exact candidate SHA. A deterministic Trust Engine, not a Builder or Verifier assertion, decides whether required evidence is sufficient for integration. Builder and Verifier may temporarily use the same underlying model in budget Alpha, but they remain distinct roles, Runs and contexts so either model can be changed independently.

Agent Profiles are the configuration boundary for role, runtime, requested model and reasoning policy. Each Run snapshots its effective configuration so historical model/usage data does not change when a profile is edited.

## Status

Pre-alpha. Mac onboarding, QR pairing, outbound Node control, isolated workspaces and native Codex execution are under active Alpha integration. Autonomous Supervisor planning and the complete verifier/repair/integration trust loop are not yet production-complete.
