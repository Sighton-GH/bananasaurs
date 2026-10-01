# 0094. Short, kind replies; apologies only for real mistakes

Status: accepted. Follows docs/24 (harness evaluation of 2026-09-29). Owner decision by Bryan in that session.

## Context

In the #onboarding-leads chat the assistant opened most replies with "fair", "my bad" or "I stand corrected", treated a member's amused exclamation about a citation as a rebuke and disparaged its own answer, retorted at a joke, and closed with offers ("ask me again", "I'm good for links, reminders…"). The context and citations were correct; the failure was tone and length.

## Decision

1. `OUTPUT_RULES` (`packages/core/src/assistant/context.ts`) gains four rules: shortest possible reply and no follow-up offers; kindness and good faith, never defensive; apologise only for a real, nameable mistake, never as an opener or for a limit that is not the assistant's fault; a reaction or joke is not a correction, and an earlier answer changes only when someone names a specific error and it checks out.
2. The wizard's `friendly` style example drops "sorry" for a limit that is not a fault. Existing stored behaviour prompts keep their old example text; the `OUTPUT_RULES` rules come after it and apply to every behaviour with no re-save.
3. Apologies are **not** banned. The rule is conditional so a genuine error still gets a short, plain apology.
4. The locked safety suffix is unchanged, so `SAFETY_SUFFIX_VERSION` stays 1. `OUTPUT_RULES` is outside the output guard's protected text.

## Not decided

A deterministic output-guard backstop that strips apology openers and trailing offers is deferred until traces show the prompt change did not hold on the free model.
