# ADR 0002: Deterministic moderation independent of AI

Status: accepted

## Decision

Moderation, automod, role management, schedules, logging, and other server operations execute through typed deterministic commands and rules. LLM output may draft a proposed configuration or action but is never the enforcement authority and cannot bypass validation, authorization, confirmation, idempotency, or audit.

## Consequences

The server remains manageable during provider outages and avoids probabilistic punishment. More explicit rule, permission, and action infrastructure must be built locally. AI configuration needs a preview/validation layer instead of direct tool access.

