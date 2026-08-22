# AI quality and server understanding

The AI should be useful because the server supplies good, scoped knowledge—not because every message is pushed into a large prompt. Quality includes correctness, provenance, privacy, latency, cost, and graceful failure.

## Server-specific context pipeline

1. Resolve guild, user, channel, permissions, and interface. Reject ambiguous DM guild scope.
2. Classify the request and required capabilities without disclosing server data.
3. Load the compact reviewed server card.
4. Search the guild-only memory catalogue and resource registry.
5. Rank permission-filtered capsules using entity/keyword matches, recency, relationships, and optional semantic similarity.
6. Fetch only the best capsules and, when necessary, original message/attachment evidence.
7. Deduplicate and compile a context budget with source identifiers and a disclosure plan.
8. Route to a suitable provider/model and execute only allowed tools.
9. Return a concise answer with Discord/resource citations, uncertainty, and clear action status.
10. Record retrieval/routing metrics and optional user feedback without duplicating sensitive prompts into logs.

## Quality controls

- Owner-reviewed server card, memories, glossary, people/roles, projects, decisions, and resources.
- Hybrid retrieval with lexical search always available; semantic search is an enhancement, not the only path.
- Freshness and supersession rules so old decisions do not outrank active policy.
- Source verification for important claims and refusal to invent unavailable history.
- Prompt-injection resistance: retrieved messages, attachments, websites, and repository text remain untrusted evidence.
- Provider capability checks, deterministic fallback, budget limits, and visible degraded states.
- Context caching keyed by guild, permission scope, source versions, and expiry; never share a cache across guilds.
- Cheap lexical/entity retrieval and metadata filters run before optional embeddings or model-based reranking. Do not call an LLM or embedding service for every archived message.
- Background memory extraction, attachment parsing, and indexing are batched, deduplicated, priority-limited, and pausable from the dashboard.
- Correction workflow: feedback may create a candidate memory, but only policy/review promotes it.

## Evaluation programme

Maintain a guild-specific test set covering factual recall, decisions, current projects, people/roles, resource discovery, conversation follow-up, inaccessible-channel traps, cross-guild isolation, stale/superseded memory, deleted data, attachments, prompt injection, provider failure, and token-budget pressure.

For each test, record expected sources, forbidden sources, required answer facts, acceptable uncertainty, and maximum context budget. Track retrieval recall, irrelevant-context rate, citation correctness, factual grading, permission violations, latency, context tokens, answer tokens, provider cost, and fallback frequency.

Draft changes to instructions, memory selection, ranking, summarization, provider profiles, or tools run against this suite from the dashboard before publication. A cross-guild disclosure or unauthorized-channel retrieval is a release-blocking failure.

## Dashboard AI workspace

The dashboard chat uses the same assistant runtime as Discord and is always bound to the selected guild. It exposes conversations, attachments, sources, memory capsules, context/routing traces, feedback, corrections, provider selection, and test scenarios according to the viewer’s permissions. Administrative visibility into retrieval does not automatically grant visibility into source content.
