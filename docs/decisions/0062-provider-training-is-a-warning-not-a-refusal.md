# 0062. Provider training is a warning, not a refusal

Date: 2026-09-23
Status: accepted (owner decision 2026-09-23); supersedes the refusal half of hard rule 5 and REVIEW §A2.

## Context

The assistant refused to send any content to a provider whose terms record says
`trainsOnInput` is `yes` or `unknown` (`assertProviderEligible` in
`packages/core/src/providers/eligibility.ts`, the terms step of the setup tracker).
The owner uses Gemini, whose terms record says it may train, and has explicitly
chosen to allow training on what is sent.

## Decision

`trainsOnInput` other than `no` no longer blocks a provider call. It produces
warnings instead: a `warn` log line per assistant invoke, a `warning` state on the
dashboard setup step, and the existing `doctor`/overview `not-no` warnings, which
stay. A terms record must still exist, and `productionUseAllowed` is still enforced.
PRIVACY.md tells members plainly that the provider may train on what is sent.

## Consequences

The owner accepts the risk that this conflicts with Discord's Developer Policy,
which restricts using Discord content to train AI models; that risk was stated to
the owner before the decision. Club members' excerpts may be used for training by
the provider. Switching to a no-training provider (for example Gemini's paid tier)
and recording `no` removes every warning without code changes.
