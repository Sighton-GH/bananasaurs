# Bananasaurs

Bananasaurs is a local-first AI assistant and server-management bot for one engineering-club Discord server. It is intended to grow into a self-hosted replacement for general-purpose bots such as Carl-bot or Dyno while retaining unusually strong server context and memory.

The moderation and automation engine is deterministic and remains available when AI providers fail. The AI assistant can explain server state, retrieve context, suggest configuration, and prepare reviewed changes; it is not the authority that decides whether a moderation action is allowed.

**Status:** planning complete and reviewed. `REVIEW.md` is the current source of truth where it contradicts an older document. Implementation has not started.

## Non-negotiable product rules

- Respond only to an explicit mention or command.
- In DMs, provide deterministic help/FAQ only by default. AI access requires explicit per-user, per-server authorization in the dashboard.
- Start owner-only; allow the owner to authorize additional members and roles. A limited member-facing tier comes after Release 3.
- Keep canonical history, memory, instructions, configuration, reminders, and audit records on the self-hosted server.
- Archive only the channels and forums the owner has explicitly enabled. Default-deny (ADR 0009).
- Send providers only the context needed for a request, and only to providers verified not to train on it (ADR 0010).
- Never let a provider become the canonical memory or identity.
- Treat every guild as a strict data boundary: memory, context, archive, permissions, instructions, resources, cases, and configuration never cross servers.
- Ship as a self-hosted Linux application for consumer hardware; do not require a hosted Bananasaurs control plane or heavyweight distributed infrastructure.
- Dashboard access comes only from an owner-provisioned local account. Discord Administrator grants nothing (ADR 0012).
- Consequential Discord actions come only from explicit moderator commands or owner-approved deterministic rules. AI-generated action plans require a preview, permission check, and confirmation.
- Assume the host is an older machine that cannot run useful generation models. Small local embedding models are optional and off by default.
- Publish what the bot stores and give members a way to see and remove it (`PRIVACY.md`, `/privacy`, `/mydata`, `/forgetme`).

## Reading order

1. `REVIEW.md` — plan review, blocking issues, and the revised release plan
2. `IMPLEMENTATION_BRIEF.md`
3. `docs/01_PRODUCT.md`
4. `docs/02_ARCHITECTURE.md`
5. `docs/03_CONTEXT_MEMORY.md`
6. `docs/04_CLUB_BEHAVIOR.md`
7. `docs/05_PROVIDERS.md`
8. `docs/06_DASHBOARD_TARGET.md` — target state, not Release 1 scope
9. `docs/07_SECURITY_OPERATIONS.md`
10. `docs/08_ROADMAP.md` — three releases
11. `docs/09_OWNER_SETUP.md`
12. `docs/10_MODERATION_AUTOMATION.md`
13. `docs/11_OPEN_SOURCE_REUSE.md`
14. `docs/12_OPEN_QUESTIONS.md`
15. `docs/13_FUTURE_FEATURES.md` — backlog, not commitments
16. `docs/14_AI_QUALITY.md`
17. `docs/15_LINUX_RESOURCE_BUDGETS.md`
18. `docs/16_BUILD_WITH_CLAUDE_CODE.md` — setup, workflow, and kickoff prompt
19. `docs/17_OPERATOR_ACCESS.md` — SSH, the operator CLI, and running Claude Code against a live instance
20. `docs/18_SAFETY_AND_BLAST_RADIUS.md` — the seven layers that bound what a bug can do, and the rollout sequence

`docs/RELEASE1_CONFIG.md` is the blank-slate configuration sheet: the panels and logging to build.
`docs/KICKOFF_PROMPT.md` is the prompt to paste into Claude Code to start implementation.
`.env.example` is the template for `.env`, which holds the bot token and IDs and is never committed.

Decisions live in `docs/decisions/`. ADRs 0008–0013 carry the stack, archive scope, provider eligibility, license, dashboard authentication, and operator access.

`CLAUDE.md` and `AGENTS.md` are handoff files for implementation agents. The documents define boundaries, outcomes, and invariants while intentionally leaving framework-level detail open where it remains reversible.

`PRIVACY.md` is the member-facing policy and needs the placeholder fields filled in before it is posted.
