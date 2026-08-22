# Context, archive, and memory

These are separate systems and must stay conceptually distinct.

## Recommended memory library

The proposed “catalogue first, then open the relevant memory” design is sound as progressive disclosure. The catalogue should be a database-backed index, not one giant prompt file and not the sole source of truth.

Use four layers:

1. **Server card:** a compact, reviewed summary of identity, purpose, terminology, key roles, active projects, and major policies. It is usually loaded, with a strict token budget.
2. **Memory catalogue:** metadata only—stable ID, title, type, entities/tags, scope, visibility, dates, confidence, status, relationships, estimated token cost, and storage reference. Server-side search examines this layer; the entire catalogue is not sent to the model.
3. **Memory capsules:** short, self-contained records for a decision, project fact, person/role, meeting outcome, process, glossary item, or ongoing work. Only top-ranked capsules enter context.
4. **Source evidence:** archived messages, attachments, resources, and decision records fetched only when a capsule needs verification or the user requests detail.

The owner may export the catalogue as sharded JSONL or Markdown manifests for inspection and backup, but generated files should be rebuilt from authoritative storage. Shard by domain or time so no single file becomes a concurrency, privacy, or scale bottleneck.

Moderation cases, infractions, permissions, and automod events are authoritative operational records, not conversational memories. They may be summarized for authorized staff, but they must not be embedded into ordinary member retrieval.

## Archive

The archive is a permission-scoped local copy of Discord history for continuity, search, and recovery. **Scope is default-deny (ADR 0009):** no channel, forum, or category is archived until the owner enables it in the dashboard. Enabling a category covers channels created in it later, and the dashboard says so at the moment of enabling. Forums are enabled as a unit and their posts inherit the parent policy; threads never carry a policy of their own. Disabling a channel stops future ingestion without deleting what was already stored. Ingestion is incremental and idempotent, with optional periodic reconciliation.

The logging module is not the archive. It forwards edits, deletions, joins, leaves, and role changes to owner-configured log channels, operates server-wide by configuration, does not feed retrieval, and has its own retention setting.

Attachments in enabled channels and smaller than 10 MB are eligible for retention and indexing. The dashboard sets per-channel handling: `none`, `metadata`, or `bytes`, plus type allowlists, parsing, storage, and backfill. Unsafe or unsupported types remain opaque attachments rather than being executed or blindly parsed.

**Discord attachment CDN URLs are signed and expire in roughly 24 hours.** A stored URL is dead by the next day and must be refreshed through the API. `metadata` mode therefore records only that a file existed, its name, type, size, and hash — it is not a way to keep the file. Anything worth keeping is downloaded at ingest under `bytes`. Deduplicate by content hash.

Live messages in enabled channels, their eligible attachments, and accepted memories default to indefinite retention until the owner sets a policy. Because scope is now an explicit allowlist, storage growth is bounded by owner choice rather than by server activity; forecasts, growth alerts, exports, purge previews, and backup rotation remain available but are no longer a primary risk.

When Discord reports a deletion, add a tombstone and retain the content on a tier (ADR 0009): 30 days for an ordinary deletion, until case close plus 90 days when pinned to an open moderation case, indefinitely when the owner explicitly marks it preserved. Tombstones themselves are kept indefinitely. Deleted content is excluded from ordinary member retrieval and requires a separate archive or moderation capability to inspect.

`MESSAGE_DELETE` does not report who deleted a message or why. Actor and reason are inferred by correlating the guild audit log by target and timestamp; the correlation is delayed, best-effort, and absent entirely for self-deletions. Every surface that displays it must label it inferred. Channel-policy changes still affect future ingestion and retrieval. A backup copy is not permission to reveal content: retrieval re-checks current Bananasaurs authorization and channel policy.

All archives, catalogues, capsules, summaries, indexes, and retrieval caches are guild-specific. A memory ID cannot reference another guild. DM help does not enter server memory. Dashboard-authorized DM AI uses an explicit guild scope, and DM conversation retention remains a separate owner setting.

## Context compilation

For each request, assemble a disclosure plan before contacting a provider:

1. core assistant instructions;
2. interface and permission context;
3. current request and recent conversation;
4. narrowly retrieved archive excerpts;
5. relevant reviewed memories;
6. relevant curated resources;
7. allowed tool descriptions.

Before step 4, the server should classify the request, determine allowed scopes, search catalogue metadata, and retrieve candidate capsules. Only after permission filtering may lexical scoring, entity matches, recency, relationship expansion, and optional semantic similarity rank candidates. If confidence is low, prefer asking a focused question or performing a narrow archive search over filling the prompt with weak matches.

Use budgets per section, deduplicate overlapping evidence, prefer primary/recent sources, and retain source IDs for citations. Do not dump an entire channel or memory store into a prompt.

A practical compiler may reserve separate budgets for the server card, current conversation, catalogue result headers, selected capsules, and raw evidence. Exact values should be measured, not fixed in this plan. Record what was selected and why so retrieval can be evaluated without logging sensitive full prompts.

## Memory lifecycle

Candidate memory can be proposed automatically but should pass policy before becoming durable. Each memory should include:

- normalized content;
- type such as decision, project fact, preference, person/role, or ongoing work;
- scope and visibility;
- source/provenance;
- confidence;
- created, reviewed, last-used, and expiry timestamps;
- status such as candidate, active, superseded, rejected, or expired.
- stable ID, related-memory IDs, and a small token estimate.

Prefer explicit decisions and stable facts. Avoid secrets, casual chatter, sensitive personal details, speculative claims, and duplicates. Contradictions should create review work, not silent overwrites.

Memory extraction should be asynchronous and selective. Cheap deterministic signals can first identify candidates such as explicit decisions, repeated facts, named projects, meeting summaries, or owner pin/save actions. An optional model can normalize those candidates in batches. No LLM call is required for every Discord message.

## Retention and purge

- Separate policies for raw archive, generated summaries, embeddings/indexes, conversations, memories, attachments, and audit records.
- Automated expiry runs as a restart-safe scheduled job and records what policy was applied.
- Owner purge supports item, user, channel, category, and date-range scopes with preview/dry-run where practical.
- Deletion propagates to derived summaries and indexes. Backups follow their documented rotation rather than promising impossible immediate erasure.

For the selected permanent-deletion archive policy, a Discord deletion does not trigger this purge path. Instead, ordinary search/index entries are tombstoned or restricted while protected archive evidence remains. An explicit owner purge must propagate through capsules, summaries, indexes, caches, attachments, and future backup rotation.

## Retrieval quality

Retrieval is **SQLite FTS5 lexical search with recency, source, and permission filtering**, and nothing else, until measurement on real club data shows it is insufficient. A MiniLM-class local embedder costs 150-400 MB resident, which cannot coexist with the 512 MB target in `docs/15`; embeddings are an optional module, off by default, with their memory cost documented at the point of enabling. Provider-side embeddings are subject to the ADR 0010 eligibility gate like any other disclosure.

Evaluate retrieval with a small owner-authored question set: expected memories/sources, forbidden scopes, acceptable token cost, and freshness. Measure recall, irrelevant-context rate, citation accuracy, permission failures, and average context tokens. A memory library is useful only if it is safer and cheaper than dumping history.
