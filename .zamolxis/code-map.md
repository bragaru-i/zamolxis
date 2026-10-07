# Code map

Where things live, by area. Agents start from these files. Keep it short: one line per area, paths from the repository root.

## Web app (apps/web/app/features)
- Home shell, sidebar layout, top bar, keyboard shortcuts, Settings opening: `workspace.tsx`
- Sidebar: chat and session list, search, filters, Home chat (Orchestrator) messages, proposals: `sessions.tsx`
- One Work Session (header, workflow picker, messages, approvals in the session): `session-view.tsx`
- Session map (which agent does each step) and its agent change sheet: `work-map.tsx`
- Agent run detail (steps, files, usage, failure): `run-detail.tsx`, `run-detail-model.ts`, `failure.tsx`
- Planner activity ("Show what I did"): `supervisor-log.tsx`
- Approvals toasts and chips: `approvals.tsx`
- Publish / pull request button: `publish.tsx`
- Settings shell and menu: `settings.tsx`; Workflows, My agents, per-computer workflow: `workflow-settings.tsx`; job editor (approvals, limits): `agents.tsx`; agent and model names: `agent-names.ts`
- Computers & projects (computers, repositories, GitHub access): `macs.tsx`, `github-access.tsx`, `products.tsx`
- Usage, Storage, People, Devices pages: `usage.tsx`, `storage.tsx`, `people.tsx`, `devices.tsx`
- Onboarding (pairing a computer): `onboarding.tsx`
- Shared UI components (Button, Sheet, Picker, Composer, Toast) and all CSS: `packages/ui/src/index.tsx`, `packages/ui/src/styles.css`
- Preview harness fixtures (run the app without a backend): `apps/web/preview/fixtures.ts`

## Backend (convex)
- Data model: `convex/schema.ts`
- Home chat and proposals (submit, openProposal): `convex/orchestrator.ts`
- Session messages and planning results: `convex/supervisor.ts`; tasks: `convex/tasks.ts`; sessions: `convex/sessions.ts`
- Starting agent runs and their instructions (Builder, Verifier, Repair): `convex/runs.ts`
- Verification, trust and repair flow: `convex/lib/lifecycle.ts`, `convex/trust.ts`
- Pull request publishing and its description: `convex/integration.ts`
- Node API (heartbeat, run completion, evidence): `convex/node.ts`
- Agent profiles, saved agents, workflows: `convex/agentProfiles.ts`, `convex/agents.ts`, `convex/workflows.ts`, `convex/lib/agentProfiles.ts`, `convex/lib/workflowPresets.ts`
- Usage totals: `convex/usage.ts`; repositories and computers: `convex/repositories.ts`, `convex/workstations.ts`

## Node on the owner's computer
- CLI (`pnpm zamolxis setup|update|watch|doctor`): `apps/node/src/cli.ts`, `setup.ts`, `update.ts`, `watch.ts`
- Daemon wiring (which runtimes run here): `apps/node/src/daemon.ts`; local model detection: `apps/node/src/local-model.ts`
- Command loop (plans, runs, candidate commit, checks, publish): `packages/node-core/src/control-plane/driver.ts`
- Planner and Home chat prompts and parsing: `packages/node-core/src/capabilities/supervisor.ts`, `packages/node-core/src/capabilities/orchestrator.ts`
- Verification checks, lockfile update, acceptance verdict: `packages/node-core/src/verification/`
- Runtimes: `packages/runtime-codex/src`, `packages/runtime-claude/src`, `packages/runtime-local/src`; shared runtime types and secret redaction: `packages/runtime-core/src`

## Checks and docs
- Whole check: `pnpm check` (lint, boundaries, typechecks, tests, build); tests sit next to the code (`*.test.ts(x)`) and in `tests/` for backend flows
- Status and known gaps: `docs/alpha-status.md`; procedures: `docs/agent-runbook.md`
