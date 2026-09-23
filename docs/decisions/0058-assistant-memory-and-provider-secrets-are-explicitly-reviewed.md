# 0058. Assistant memory is reviewed and dashboard provider keys are encrypted instance state

Date: 2026-09-22
Status: accepted

## Context

Release 3 needs a small guild-scoped memory visible to operators, member opt-out and deletion, and provider setup from the WebUI. Memory can affect future model context, so model-authored text must not silently become durable truth. Provider credentials must survive restart without entering process environment through the browser, but must never be returned by an API after entry. Provider selection is process-level rather than guild-level because one daemon owns the provider boundary and eligibility ledger.

## Decision

Store server cards, sectioned curated memory, and member memory preferences as guild-partitioned tables with the normal composite guild keys and repository scope. A model may create only a `memory` proposal. An operator reviews it, supplies or edits section/content/optional member subject, and one storage transaction writes the memory and marks the proposal saved. Invalid input leaves the proposal reviewed and retryable. Operators can opt a member out or delete member-specific entries; opt-out removes that member's entries from compiled context.

Store one instance-level assistant provider configuration. Its API key is encrypted with AES-256-GCM under a key derived from `ASSISTANT_PROVIDER_SECRET_KEY`; nonce and authentication tag are stored with ciphertext. The WebUI can replace a key, but reads expose only `keyConfigured`. Missing or wrong master key fails closed to provider off. Actual traffic remains behind the existing provider eligibility check.

## Consequences

The instance-level schema exemption is deliberate and pinned by the invariant test. Backups contain ciphertext, not the raw provider key, but restoring them also requires the same host master secret. Rotating that secret requires entering replacement provider keys. Memory writes are slower than direct model writes because human review is mandatory; that is the intended trust boundary.
