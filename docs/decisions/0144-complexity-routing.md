# 0144. Deterministic complexity routing

Date: 2026-10-11

Status: accepted (owner decision D16, 2026-10-10).

## Context

Simple greetings should not spend the standard Gemini daily quota of 20 requests per project. A model-based
classifier would cost a provider request and could route nondeterministically.

## Decision

1. A pure deterministic function `routeRun(input, rules)` selects `light` only for short messages with no
   attachments or quote/reply, no full-model keyword, and at most four earlier turns. Configurable
   greeting/thanks/emoji patterns stay light even in long conversations.
2. A light run tries light entries first, then standard entries in order; a standard run tries standard entries in
   order, then light entries last. A light run that invokes a tool switches to standard for its next model round
   (configurable, on by default).
3. Router rules and background-job tiers are instance settings visible on the dashboard. Routing is auditable
   through a fixed reason string and the `routed` run event. No classifier call is ever made.

## Consequences

- Misclassification is corrected by the owner through editable keyword and greeting lists, not code changes.
- Background summaries and the daily digest default to the light tier, keeping Flash quota for members.
