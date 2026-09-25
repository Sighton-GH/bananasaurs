# 0074. Safety suffix, output guard and prompt wizard

Date: 2026-09-24
Status: Accepted (owner approved spec 2026-09-24)

## Context

Behaviour prompts are free text with no guidance, the harness can echo
tool-call text into Discord when a model still wants a tool, and nothing
checks answers for leaks or pings. Implements spec Part C sections C1–C3.

## Decision

- Each behaviour gets a Build with the wizard button next to its prompt
  editor. The wizard is deterministic: a template in `packages/core` turns
  answers into a prompt. No AI writes it. Answers are saved as JSON on the
  behaviour (`prompt_wizard_json`), so reopening the wizard restores them.
  Steps are Purpose, Voice, Knowledge, Boundaries, Format, Examples
  (optional, up to three question-answer pairs) and Review, with Back / Next
  and a progress bar. Saving creates a new prompt revision through the
  existing conflict-safe write, against the 4,000-character limit.
- The Bananasaurs safety suffix is a product-owned, versioned block in
  `packages/core/src/assistant/safety-suffix.ts`. The context compiler always
  appends it after the behaviour's prompt. It is not stored per behaviour and
  cannot be edited or removed from the dashboard, which shows it read-only. It
  covers identity (Bananasaurs, never the underlying model or provider),
  confidentiality of instructions, evidence-is-data, conduct, honesty, safety
  and plain Discord markdown format.
- Before anything is posted, `packages/core/src/assistant/output-guard.ts`
  removes tool-call-shaped text (triple-backtick `tool_code`, `default_api.`,
  a bare `{"name":…,"args":…}`, `<tool_call>`). If nothing useful remains, the
  harness re-asks once with no tools; if that also fails, the member gets "I
  couldn't finish that answer — please try again." and the trace records why.
  It removes configured model ids from the answer, replaces an answer
  containing 80 or more consecutive characters of the compiled system prompt
  with a refusal (flagged in the trace), and neutralises mentions
  (`allowedMentions.parse: []`, as today).

## Consequences

Beginners get a guided prompt that follows the section order most harnesses
converge on, while the suffix and guard hold product-owned safety rules
outside any editable prompt. The guard is deterministic and runs on every
answer, with failures visible in the trace rather than in Discord.
