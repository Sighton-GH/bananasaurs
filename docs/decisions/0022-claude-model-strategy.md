# ADR 0022: Claude model strategy — Opus, Sonnet, and free tiers together

Status: accepted (2026-08-29)

## Context

Bananasaurs is built almost entirely by Claude Code with owner review. The kickoff prompt (`docs/KICKOFF_PROMPT.md`) and `PROJECT_INSTRUCTIONS.md` both assume Opus, but Opus is the most expensive Claude tier. The owner wants the most cost-effective plan that does not sacrifice quality where it matters.

This ADR records how to split work between Opus, Sonnet, and Cline's free-tier models — by task complexity, not by habit. It is a cost-quality strategy, not a technical constraint: the code does not care which model wrote it.

## Decision

### 1. Three tiers of task complexity

Bananasaurs work falls into three clear tiers. Each maps to a model choice.

| Tier | Characteristics | Examples | Model |
|------|----------------|----------|-------|
| **A — Safety-critical reasoning** | Authorization, idempotency, guild isolation, Discord API edge cases, concurrent transaction discipline, anything where a subtle bug has real consequences (wrong ban, data leak, silent failure) | Effect gateway, reconciliation logic, moderation actions, provider router, context compiler, prompt-injection boundaries | **Opus** |
| **B — Straightforward implementation** | Schema definitions, CRUD repositories, test harness wiring, API routes with established patterns, UI components, logging event formatting | Drizzle schema, Zod validators, repository methods, Fastify routes, React components, logging module | **Sonnet** |
| **C — Mechanical / boilerplate** | Migrations, test data setup, documentation, config validation, formatting fixes, trivial refactors | drizzle-kit migrations, .env.example updates, README edits, prettier fixes, type-only changes | **Free models** |

### 2. Opus is non-negotiable for these paths

Some code is expensive to get wrong and cheap to review. Use Opus for:

- **Authorization and effect gateway** — `authorize()`, `EffectGateway`, role-hierarchy checks, protected-target logic. A bug here grants roles to the wrong person or refuses the right one.
- **Idempotency and job dedupe** — the WP3 post-mortems (`ADR 0016`, `ADR 0017`) proved this code fails silently and permanently when wrong. The fix is cheap; the regression is not.
- **Guild isolation** — every repository method, every query, every test assertion that guild scope is enforced. Cross-guild data leaks are release-blocking.
- **Discord API interaction** — rate-limit handling, partial event reconstruction, reconnect deduplication. The fake harness was wrong twice in WP3; real Discord is less forgiving than the fake.
- **Moderation actions** — bans, kicks, timeouts, automod rules. These have real consequences for real people. "Works in test" is not enough.
- **Context compiler and provider routing** — disclosure budgets, prompt-injection boundaries, fail-closed cost ceilings. Release-blocking if wrong.

### 3. Sonnet is the default for implementation

Once the design is settled (by Opus or by an existing ADR), implementation is Sonnet's strength. Use Sonnet for:

- Schema definitions following established patterns
- Repository methods that mirror existing ones (guild-scoped CRUD)
- Zod validators for new shapes
- Fastify route handlers for well-understood endpoints
- React dashboard components
- The logging module (WP4 / Release 1 remainder)
- Reminder scheduling (Release 3) once the job-table pattern is established
- Archive ingestion (Release 3) once the cursor and worker patterns are established

Sonnet is faster and cheaper. It handles "follow the existing pattern" well. It struggles with "invent the pattern" — that is Opus's job.

### 4. Free Cline models handle mechanical work

Cline offers free model access (tagged FREE in the model selector, rotating promotions) and ClinePass ($9.99/month for 2-5x rate limits on open coding models like GLM, Kimi, DeepSeek, Qwen).

Use free/ClinePass models for:

- **Migrations** — drizzle-kit generate and write rollback-safe SQL
- **Documentation** — ADR drafts, README updates, inline comments
- **Test scaffolding** — fake data builders, test file boilerplate, assertion libraries
- **Config validation** — .env.example, config shape checks
- **Formatting and lint fixes** — prettier, eslint --fix, import sorting
- **Type-only changes** — adding types to untyped code, fixing type errors in mechanical ways
- **Reviewing diffs** — "read this diff and flag anything that violates the four self-review questions" is a task free models handle well

Do not use free models for: authorization logic, idempotency, guild isolation, moderation, provider routing, or anything where a subtle mistake is expensive.

### 5. Opus plans, Sonnet acts

Cline supports different models for Plan and Act mode. Use this:

- **Plan mode: Opus** — for Tier A tasks. Let Opus explore the codebase, identify edge cases, and design the approach. Opus is better at "what could go wrong here," which is what planning is.
- **Act mode: Sonnet** — for Tier B implementation once the plan is locked. Sonnet executes known patterns faster and cheaper.
- **Tier A implementation: Opus** — if the task is safety-critical, keep Opus in Act mode too. The planning quality gain is lost if the implementer does not understand the edge cases.

This gives you Opus's reasoning where it matters (design, safety) and Sonnet's speed where it does not (implementation of settled designs).

### 6. Effort levels

Cline models support effort levels (how hard the model thinks before responding). Use them deliberately:

| Effort | When to use | Model |
|--------|-------------|-------|
| **High** | Tier A tasks: designing safety-critical code, reviewing a diff that touches authorization or idempotency, debugging a subtle failure | Opus |
| **Medium** | Tier B tasks: implementing a feature that follows an existing pattern, writing tests for a known shape, refactoring | Sonnet |
| **Low** | Tier C tasks: migrations, formatting, documentation, simple lookups | Free models |

Do not use high effort on boilerplate — it wastes tokens producing the same output low effort would. Do not use low effort on safety-critical code — it misses edge cases.

### 7. Per-slice model selection

For each work package or slice, state the model in the handoff prompt:

```
Model: Sonnet (Tier B — logging module follows established patterns)
Effort: Medium

Read docs/reports/WP3.md §8 for the WP4 plan. The design is settled.
Implement the logging module per that plan. Do not deviate into
architectural decisions — flag anything underspecified instead.

Hard rules still apply:
- Every query takes a guild ID
- Every Discord side effect has a durable idempotency key
- Model output passes a Zod validator
- Tests must fail if the implementation is broken
```

### 8. When to switch models mid-slice

Switch from Sonnet to Opus when:

- You hit a bug that requires reasoning about edge cases (not a typo)
- The implementation reveals the design was underspecified
- You need to verify guild isolation or idempotency across multiple files
- A test fails in a way that suggests a subtle concurrency or ordering issue

Switch from Opus to Sonnet when:

- The design is settled and you are following it mechanically
- You are writing tests for already-implemented code
- You are doing the second or third similar slice (pattern is now established)

### 9. Practical cost estimate

Rough distribution for the remaining work (Release 1 remainder through Release 3):

| Release | Tier A (Opus) | Tier B (Sonnet) | Tier C (Free) |
|---------|---------------|-----------------|---------------|
| WP4 logging | 20% (attribution inference, gap markers) | 70% (event formatting, routing) | 10% (migrations, docs) |
| Release 2 moderation | 50% (hierarchy, protected targets, dry-run) | 40% (case CRUD, audit logging) | 10% (migrations, tests) |
| Release 3 assistant | 40% (provider router, context compiler) | 45% (archive, FTS5, reminders) | 15% (migrations, docs) |

This is approximately 60-70% cheaper than Opus-for-everything, with quality preserved where it counts.

## Consequences

- **Opus is reserved for tasks where its reasoning advantage pays for itself** — safety-critical code, design, and debugging subtle failures.
- **Sonnet handles most implementation** — faster, cheaper, and adequate for following established patterns.
- **Free models eliminate cost entirely for mechanical work** — migrations, docs, formatting, test scaffolding.
- **The owner reviews all diffs regardless of model** — model choice affects generation cost, not review burden. The four self-review questions apply equally to Sonnet and free-model output.
- **Switching models mid-slice is normal, not a failure** — start with the model tier that matches the task, switch when the task changes character.
- **ClinePass ($9.99/mo) is worth it if doing heavy Sonnet work** — the 2-5x rate limits mean long implementation sessions do not throttle.

## Related

- `docs/KICKOFF_PROMPT.md` — originally specified Opus for everything; this ADR refines that
- `PROJECT_INSTRUCTIONS.md` — notes that review quality matters more than typing speed
- `docs/decisions/0013-operator-cli-and-claude-code-access.md` — the bright line between build-time Claude and runtime AI
- `docs/decisions/0016-job-dedupe-collapses-pending-work.md` — example of the subtle bugs Opus-tier reasoning catches
- `docs/decisions/0017-provenance-names-candidates-never-decides.md` — another
