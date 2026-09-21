# 0051. Release 3 starts with a native Gemini adapter behind the provider boundary

Date: 2026-09-20
Status: accepted

## Context

Release 3 adds the assistant. Connor selected Gemini API as its first AI integration. The
existing roadmap already requires a provider boundary, explicit routing, no-training
eligibility, citations, disclosure records and a hard spend ceiling. The repository has
eligibility records but no generation provider contract yet.

Google's current Gemini API documentation uses the native `generateContent` endpoint and
an `x-goog-api-key` header. Its current terms make the data boundary important: unpaid
Gemini API content may be used to improve Google products and may be read by human
reviewers, while paid Gemini API prompts and responses are not used to improve Google's
products. Therefore an unpaid key cannot pass the existing `trainsOnInput: no` gate for
Discord server content.

## Decision

Start Release 3 with a small native Gemini text adapter behind a provider-neutral
`TextProvider` contract. The adapter owns only transport and response normalisation. It
does not select a model, compile context, retrieve archive records, route requests, spend
money or expose a Discord command.

- API keys are constructor inputs and are sent only in `x-goog-api-key`, never a URL or
  log field.
- Models remain explicit request inputs. No model alias is silently pinned in code.
- Authentication, rate limit, timeout, outage, safety refusal, invalid request and invalid
  response failures are normalised.
- Usage metadata is returned when Gemini supplies it, so the later router can enforce
  budgets without provider-specific parsing.
- Eligibility is checked separately and fails closed. `trainsOnInput` must be `no`; the
  club audience additionally requires `productionUseAllowed`.
- The initial capability set records the native surface without yet enabling tools or
  attachments in Bananasaurs.

No real Gemini request is made in this slice. A production key, billing status, monthly
spend ceiling, selected model and enabled guild are deployment decisions and are not
invented in code.

## Consequences

The adapter can be tested without credentials and without disclosing server content. The
next slice can add persisted provider/model profiles, usage accounting and the hard
budget ceiling, then compose `/ask` only after the context compiler and permission tests
exist. Choosing another backend later does not change assistant or retrieval code.

## Amendment 1: three backends, zero spend and mandatory local preflight

Later on 2026-09-20 Connor selected Gemini, OpenRouter and NVIDIA NIM as user-selectable
options, set the monthly spend cap to zero, and required local scans for sensitive or
personal data, prompt injection and malicious use before any request reaches an API.

The implementation therefore adds generic OpenAI-compatible adapters for OpenRouter and
NVIDIA NIM, and a provider-independent outbound safety boundary. The boundary refuses a
whole request before network I/O when a known personal-data, secret or prompt-injection
pattern is found. The zero cap permits only profiles explicitly classified as free; an
unknown or paid cost class fails closed.

This scan is deliberately described as risk reduction, not proof. Pattern and heuristic
checks have false negatives and false positives. They cannot infer every personal fact,
recognise every obfuscated secret, or guarantee that retrieved text is benign. Provider
terms and data-use claims are also evidence, not a technical guarantee. The system must
show those limits rather than claiming that a request is safe because the scanner found
nothing or because a provider says it does not train on data.
