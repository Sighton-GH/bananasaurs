# Provider strategy

Revised 2026-08-22. Provider availability, free tiers, model catalogs, prices, authentication rules, and terms change. Every fact below is runtime configuration and must be verified against current official documentation during implementation and setup — not against this document.

## Principles

- Support multiple backends without scattering provider-specific logic.
- Preserve capabilities rather than forcing every model to the lowest common denominator.
- Prefer explicit routing profiles and deterministic fallback before "smart" routing.
- No provider is entitled to canonical conversation or memory state.
- Quota-saving techniques must comply with provider terms. No credential sharing, no subscription credentials in an application, no undocumented endpoints, no authentication bypasses.

## Eligibility gate (ADR 0010)

Every provider profile carries:

```
trainsOnInput:          "no" | "yes" | "unknown"
noTrainingEvidenceUrl:  string    // link to the exact clause
productionUseAllowed:   boolean   // free tiers frequently forbid it
termsReviewedAt:        date
```

Two hard rules in the router, with no override:

1. **No server content — archive excerpt, memory capsule, attachment text, or member message — reaches a provider unless `trainsOnInput === "no"`.** `"unknown"` is treated as `"yes"`. This is Discord Developer Policy rule 21, not a preference.
2. **A profile with `productionUseAllowed: false` cannot serve the club guild.** It serves the test guild only.

`termsReviewedAt` older than six months raises a dashboard warning. A verification without a date is not a verification.

## Selected providers

**Development and evaluation: NVIDIA NIM free tier** (build.nvidia.com), via the generic OpenAI-compatible adapter. Reported not to train on prompts, which clears rule 21 — but the free tier is documented as development, testing, research, and evaluation only, so it is flagged `productionUseAllowed: false` and is restricted to the test guild and synthetic content. Verify both claims against NVIDIA's current terms and record the URLs before use.

**Production: a paid API key under commercial terms.** At roughly 30 members with explicit-invocation-only usage, expected spend is small. Configure a hard monthly ceiling that fails closed. The generic OpenAI-compatible adapter covers most candidates; add a first-class adapter only where native behaviour materially improves reliability or capability.

**Not a provider: the Claude CLI subscription.** Claude Pro/Max grants usage rights to Claude Code and Claude.ai as products, not a credential for powering an application, and Anthropic's Consumer Terms prohibit automated non-human access outside an API key. The subscription builds Bananasaurs; it never serves a request from it. The previously-proposed experimental Claude Code / agent-runtime adapter is **cancelled**, not deferred — the terms question it was waiting on has been answered. Claude as a production model means an Anthropic API key under the Commercial Terms, like any other provider.

Additional candidates once they pass the gate: Groq, OpenRouter (per-model, since its free models vary), Gemini, Anthropic API, Cloudflare Workers AI, DeepSeek, and other compatible endpoints. Each needs its own eligibility record; a provider is not eligible because a sibling model is.

The Mint box is not expected to run local generation. Ollama and vLLM are not a required fallback. A local embedding model is optional and off by default (`REVIEW.md` §C11).

## Capability model

Track at least streaming, tool calls, structured output, vision, reasoning controls, context limits, usage reporting, and provider-native options. Validate configured models by probing them rather than trusting names.

## Routing profiles

- `fast` — prioritise latency.
- `quality` — prioritise answer quality within owner-set cost limits.
- `free` — free **and** no-training **and** production-permitted. This will usually be empty for the club guild. That is the correct outcome, not a limitation to engineer around.
- `vision` — require image input support.
- `manual` — pinned provider and model, no implicit change.

Each profile declares ordered candidates, required capabilities, retry policy, fallback-trigger classes, daily and monthly budget, and whether the user must be told when a backend changes. Never retry non-idempotent tools as part of provider fallback. Fallback that would violate the eligibility gate does not happen — the request fails visibly instead.

## Errors and observability

Normalise authentication, quota, rate-limit, timeout, safety refusal, invalid request, provider outage, and capability mismatch. Capture latency and usage where supplied. The dashboard shows why a route was selected, why fallback occurred, and which disclosure classes were sent — without exposing credentials or full prompt bodies.
