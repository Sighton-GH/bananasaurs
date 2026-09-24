# 0075. Several providers, one ordered model chain

Date: 2026-09-24
Status: Accepted (owner approved spec 2026-09-24)

## Context

One provider row with a model plus fallbacks cannot express "try Gemini, then
OpenRouter, then NVIDIA in an order I choose". The owner decided (spec
decision O5) for several providers at once with one ordered list. Implements
spec Part G, and supersedes ADR 0068's fallback list.

## Decision

- Providers (new table `assistant_providers`, instance-level like today's
  config): one row per provider (Gemini, OpenRouter, NVIDIA NIM), each with
  its own sealed API key, cost class, enabled flag, and its own terms record
  (hard rule 5 applies per provider; an ineligible or "may train" provider
  shows its warning).
- Model order (new table `assistant_model_chain`): an ordered list of up to 6
  entries, each provider plus model. AI setup shows it as a list with drag
  handles and up/down buttons (keyboard-accessible), labelled 1 · Primary,
  2 · Fallback, and so on. Each row shows the provider's status (key set,
  terms reviewed, tools supported) and a Test button that sends a one-word
  prompt.
- At run time the harness tries the chain in order, moving on when a model is
  busy, rate-limited, timed out, or its provider is ineligible or
  unconfigured. Once a request has started a tool loop on one entry, it stays
  on that entry. If that entry fails mid-loop, the request restarts from round
  1 on the next entry. The trace records every attempt.
- Migration: the current single config row becomes one provider row plus its
  model and fallback models as chain entries. `AI_PROVIDER` / `AI_MODEL` in
  `.env` still work as a seed on a fresh install. The Gemini "load models"
  list (ADR 0068) generalises to each provider's model picker where the
  provider offers a model list.
- AI setup page layout: (1) Model order, (2) Providers (one card each: key,
  terms, cost), (3) Web search (Brave), (4) GitHub token, each with a status
  pill (Ready / Needs attention / Off).

## Consequences

The club can mix free and paid providers with explicit fallbacks instead of
one provider and its models. Chain entries are provider-scoped, so a
mid-loop failure restarts cleanly on the next entry rather than carrying
provider-specific state across.
