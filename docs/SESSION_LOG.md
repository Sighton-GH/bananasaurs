# Session log

Append-only. One entry per slice, per `docs/20_AUTONOMOUS_EXECUTION.md`.

---

## WP1 / slice 1 — workspace, config, logging, CI, systemd — 2026-08-22

**Changed.** npm workspace with `packages/core` and `apps/daemon`. TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Zod config loader that reports every problem at once and never echoes a rejected value. Pino logger with an allowlist projection. ESLint flat config, Prettier, Vitest, GitHub Actions CI, systemd unit.

**Broke, to check the tests.**

1. Turned the allowlist guard in `safeLogFields` into `if (false)` so unknown fields pass through → 3 tests failed, including the one asserting a field nobody thought to ban still gets dropped.
2. Flipped `BANANASAURS_DRY_RUN` default from `'1'` to `'0'` → 2 tests failed.
3. Relaxed `DASHBOARD_SESSION_SECRET` from `.min(32)` to `.min(1)` → 1 test failed.

All three restored; 23 tests green.

**Found by running it.** The startup debug line logged `droppedFields: 17` and nothing else: `redactConfig` emits SCREAMING_CASE env keys while the log allowlist holds camelCase domain fields, so filtering twice dropped everything. Fixed by logging `redactConfig(config)` directly — a bounded key set with secrets already replaced — with a test asserting no secret value reaches the logger. This is the kind of bug the test suite would never have caught, because both halves were individually correct.

**Deferred.** `dependency-cruiser` is not installed; see the decision note below. `packages/testkit`, `storage`, `discord`, `http`, `dashboard`, `cli` do not exist yet — slices 2a and 3 and later packages.

**Decision.** Module boundaries are enforced by workspace manifests rather than `dependency-cruiser`. `packages/core/package.json` depends only on `pino` and `zod`, so importing `discord.js` or `better-sqlite3` from core fails to resolve. That is free, needs no new dependency, and `docs/20` requires a stop before adding one beyond ADR 0008. ESLint `no-restricted-imports` covers the intra-package rules, including a hard ban on `child_process` per ADR 0013. The accepted plan named `dependency-cruiser`; this is a deliberate departure and is cheaper.
