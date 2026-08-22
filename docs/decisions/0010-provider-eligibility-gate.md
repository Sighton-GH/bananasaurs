# ADR 0010: Provider eligibility gate, and separate development/production providers

Status: accepted (2026-08-22)

## Context

Two constraints collide with the owner's preferred providers.

**Discord Developer Policy rule 21** prohibits using message content obtained through the API to train machine-learning models, including LLMs, without Discord's express permission. Inference is not training, so calling a provider is fine — but only if that provider does not train on what it receives. Most free tiers reserve exactly that right.

**Anthropic's Consumer Terms** prohibit accessing Claude through automated or non-human means except via an API key or where Anthropic explicitly permits it. Claude Pro/Max subscriptions grant usage rights to Claude Code and Claude.ai as products, not a credential for powering an application. Anthropic began enforcing this against third-party harnesses in 2026, and the Agent SDK now requires API-key authentication. A Discord bot calling Claude on a subscription is squarely on the wrong side of that line.

**NVIDIA's hosted NIM catalogue** (build.nvidia.com) reportedly does not train on prompts, which clears rule 21. But its free tier is documented as being for development, testing, research, and evaluation — serving real end users is production use requiring a licence. That clears one gate and fails another.

## Decision

### 1. Every provider profile carries an eligibility record

```
trainsOnInput:          "no" | "yes" | "unknown"
noTrainingEvidenceUrl:  string    // link to the exact clause
productionUseAllowed:   boolean   // free tiers frequently say no
termsReviewedAt:        date
```

**Hard gate in the router:** no archive excerpt, memory capsule, attachment text, or member message may be sent to a provider unless `trainsOnInput === "no"`. `"unknown"` is treated as `"yes"`. There is no override flag; if a provider cannot be verified, it cannot receive server content.

`termsReviewedAt` older than six months raises a dashboard warning. Terms change; a verification with no date is not a verification.

### 2. Development and production providers are separate configuration

- **Development / evaluation:** NVIDIA NIM free tier. **This is the confirmed interim choice** — the project is built and tested against NIM so there is a free path to a working assistant. Used against the test guild and synthetic content only. Marked `productionUseAllowed: false`, and the router refuses to serve the club guild from a profile with that flag. The switch to a paid profile happens when the bot is production-ready and is a configuration change, not a code change.
- **Production:** a paid API key under commercial terms. At roughly 30 members with explicit-invocation-only usage, expected spend is small — a hard monthly ceiling is configured and fails closed.

### 3. The Claude subscription is a build tool, not a runtime

Claude Code on the owner's subscription writes the code. It is never a runtime inference path for the bot. The experimental "Claude Code / agent-runtime adapter" in `docs/05` is **cancelled**, not deferred — the terms question it was waiting on has been answered.

If Claude is wanted as a production provider, it is reached with an Anthropic API key under the Commercial Terms, like any other provider.

### 4. Verify before relying on any of this

The NVIDIA and Anthropic findings above come from secondary sources dated 2026. Before the first production request, read the current terms directly at the provider's own site, record the URL and clause, and set `termsReviewedAt`. This ADR records a decision and its reasoning; it is not a substitute for the primary document.

## Consequences

- The `free` routing profile in `docs/05` is redefined as "free **and** no-training **and** production-permitted," which will usually be an empty set. That is the correct answer, not a limitation to engineer around.
- There will be a small recurring cost once the bot serves the real server. Budget for it rather than designing around a free tier that forbids the use.
- Development stays free, which is where the volume is anyway.
- The generic OpenAI-compatible adapter is worth more than expected: NIM, most paid providers, and future options all speak it, so provider swaps stay cheap.
- Quota-saving techniques that rely on subscription credentials, credential sharing, or undocumented endpoints are out of scope permanently.
