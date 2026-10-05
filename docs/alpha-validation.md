# Alpha validation — 2026-10-05

Implementation work used an isolated integration worktree from main
`4da3be5ba30b714085e8d856bbc686fcb9b4049f`. Only the intended Alpha commits
were imported from the divergent launch/identity/profile/trust lanes; the native
Codex commits already represented by squash merge #44 were not replayed.

## Checks actually run

- `pnpm check`: PASS (lint, package boundaries, workspace TypeScript, Convex
  TypeScript, package tests, Convex/control-plane tests, production Next.js build).
- `pnpm exec vitest run tests/control-plane-loop.test.ts -t 'independent builders concurrently'`:
  PASS (two actual concurrent fixture Builders, separate worktrees, independent
  Verifiers and both trusted dependency commits in the downstream workspace).
- `ZAMOLXIS_CODEX_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t 'runs text intent'`:
  PASS (installed Codex 0.160.0, real authenticated Builder edits, Node candidate
  commit, separate read-only native Verifier, executed package acceptance check,
  SHA-bound evidence, deterministic trust, prepared integration branch and final
  Session completion; canonical HEAD/status unchanged).

The default disposable-repository acceptance exercises an intentionally failed
check, deterministic trust failure, one Repair, a new candidate, re-verification,
trust PASS and integration. Backend tests additionally prove exhaustion at two
repairs, verifier capacity, dirty/stale provenance, ownership/Product isolation,
replay, profile resolution/limits and reported telemetry. Temporary auth-only
profiles are removed in cleanup; no credential contents are logged or committed.
The authenticated Repair mode also passed:

```sh
ZAMOLXIS_CODEX_ACCEPTANCE=1 ZAMOLXIS_CODEX_REPAIR_ACCEPTANCE=1 pnpm exec vitest run tests/control-plane-loop.test.ts -t 'runs text intent'
```

Codex deliberately wrote the first failing candidate, then a separate native
Repair produced a new SHA. Both candidates received distinct native Verifier
workspaces; the original failed trust remained observable. The repaired candidate
passed checks/trust and reached integration/Session completion in 102 seconds,
with canonical HEAD/status unchanged.

The native test uses actual Convex function implementations in `convex-test`
with fixture identities. It does not establish deployed OIDC/device auth,
public phone pairing or launchd E2E. No production deployment settings changed.
Automatic approval review rejected `convex dev --once` because it could upload
backend code or mutate a hosted development deployment. Live deployment/schema
validation therefore remains an external validation boundary.

Next.js regenerated tracked metadata during checks; generated-only changes were
restored to their original contents in the canonical checkout. Canonical runtime
workspaces were forbidden and no implementation agent ran there. The executable
and companion documentation canonical checkouts are left clean.
