# Agent guidance

Read `IMPLEMENTATION_BRIEF.md` and all documents in `docs/` before proposing the initial implementation plan.

Treat product rules, privacy boundaries, and acceptance criteria as requirements. Treat examples of APIs, schemas, file layouts, frameworks, and retrieval methods as suggestions.

Before major implementation:

1. Record consequential choices in `docs/decisions/` as short ADRs.
2. Identify the thinnest end-to-end slice and its tests.
3. Call out any requirement that depends on current provider or Discord policy.
4. Keep provider credentials, Discord tokens, and tunnel secrets outside source control.

Do not add autonomous write actions, DM behavior, broad guild access, or silent cloud disclosure. Do not optimize for multi-tenant SaaS. Avoid speculative abstractions, but preserve clean boundaries around interfaces, providers, context, tools, authorization, and storage.

When ambiguity is reversible, make a documented choice and continue. Ask the owner only when the choice changes privacy, cost exposure, authorization, retention, or external side effects.

