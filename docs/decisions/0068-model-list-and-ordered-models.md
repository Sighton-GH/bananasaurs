# 0068. Load the models a key can use; up to three models in order

Date: 2026-09-23
Status: accepted (owner request 2026-09-23); amends the single backup model of ADR 0067's
branch before release

## Context

AI setup asked for the model name as free text, plus one optional backup model.
The owner wants the model list loaded from their Gemini API key, and wants to
choose a first, second and third model to try in order.

## Decision

- `POST /api/assistant/provider/models` (`config.write`) lists the models for
  Gemini. It uses the key just pasted into the form, or the saved key when
  none is pasted. It calls
  `GET https://generativelanguage.googleapis.com/v1beta/models` with the
  `x-goog-api-key` header. That is the host requests already go to, so there is
  no new destination. The key never goes in a URL, a log line or the response.
- Only models whose `supportedGenerationMethods` include `generateContent` are
  offered. Speech, image, embedding, audio and live models are filtered out by
  name, because the assistant needs text answers.
- The list shows what the key can see. It cannot show whether the key's tier
  has quota for a model; a model with no quota fails like a busy one and the
  next model in the order is tried.
- The saved configuration is `model` (first choice) plus `fallback_models_json`,
  up to two further models in order. Migration 0036 had not shipped, so its
  single `fallback_model` column became this list in place.
- On an overloaded, rate-limited or timed-out call, the assistant tries the
  next model in the order: at most three calls for one generation step.
  Changing the order resets the cost answer, because the free statement must
  cover every model in it.
- OpenRouter and NVIDIA NIM keep the free-text model field. Their model lists
  are not loaded.
