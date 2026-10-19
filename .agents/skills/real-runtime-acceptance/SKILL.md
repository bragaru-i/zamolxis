---
name: real-runtime-acceptance
description: Use before merging a change to packages/runtime-*, packages/node-core or apps/node, or when a fake-runtime test cannot prove adapter behaviour. Owns the real Codex and real Claude acceptance tests; not unit tests or pnpm check.
---

# Real-runtime acceptance

**Invariant:** fake runtimes do not exercise the adapters (a redaction change once broke every real plan while all tests passed). Report exact commands, results and what stayed untested.

Tests use disposable repositories and assert the canonical checkout's HEAD and status are unchanged.

## Codex (local Codex login)

```bash
ZAMOLXIS_CODEX_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t "runs text intent"          # plan -> build -> verify -> trust (required)
ZAMOLXIS_CODEX_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t "real Codex Supervisor"     # answer, stop
ZAMOLXIS_CODEX_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t "real Codex Orchestrator"   # reply, no repository
ZAMOLXIS_AUTHENTICATED_ACCEPTANCE=1 pnpm exec vitest run tests/approvals-steering.test.ts -t "real Codex approval" # reject, approve
ZAMOLXIS_CODEX_RESTART_ACCEPTANCE=1 pnpm exec vitest run tests/restart-recovery.test.ts -t "real Codex"          # resume after kill
```

Run the first always; the others when their area changed.

## Claude (owner's signed-in `claude` CLI)

Required for `packages/runtime-claude` or its Node wiring. Uses `claude-haiku-4-5`; keep usage modest, never in loops. `claude auth status` shows whether it is signed in.

```bash
ZAMOLXIS_CLAUDE_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t "Claude"   # all seven, ~2 min
```

Narrow with `-t "runs text intent with real Claude"`, `"real Claude Orchestrator"`, `"real Claude permission"` or `"real Claude Verifier"`.

## Gotchas

- `--testTimeout 1500000` on slow runs.
- On failure, log the real outcome (the Supervisor's decision and reply) before changing code: the parser's safe fallback ("answer") hides the cause.
- On Linux with AppArmor's user-namespace restriction, Codex cannot write files and "runs text intent" times out on main too; see `docs/agent-runbook.md`, "Pitfalls".
- "runs text intent" is flaky (about 1 in 3 ends "waiting" on main); rerun before blaming the change, and say so.

## Pair with

`shipping-a-change`.
