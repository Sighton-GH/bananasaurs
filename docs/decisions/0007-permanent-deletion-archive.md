# ADR 0007: Retain Discord-deleted content as protected archive

Status: accepted, amended by ADR 0009 (2026-08-22)

## Decision

When Discord reports a message or attachment deletion, keep the archived content indefinitely and add a tombstone. Exclude it from ordinary member/AI retrieval by default; allow only separately authorized archive/moderation access. Owner purge or a future policy change may remove it and its derived data.

## Consequences

The archive preserves history and moderation evidence even after Discord deletion. This raises privacy, disclosure, storage, and public-release documentation obligations. Retrieval, exports, backups, and access logs must distinguish live content from tombstoned content.

