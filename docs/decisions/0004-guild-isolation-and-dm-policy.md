# ADR 0004: Strict guild isolation and limited DM capability

Status: accepted

## Decision

All server knowledge and configuration are partitioned by guild across storage, search, embeddings, caches, jobs, exports, provider calls, and dashboard sessions. DMs use a deterministic FAQ by default. AI in DMs requires explicit dashboard authorization for a user and an unambiguous guild, then uses that guild’s normal permissions and limits.

## Consequences

Private testing remains simple while later public distribution is possible without redesigning identity boundaries. Every repository and retrieval path must carry guild scope. DM AI cannot casually blend servers or bypass channel permissions.

