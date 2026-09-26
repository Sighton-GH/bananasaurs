-- ADR 0082: the resource cache now keeps document structure. Clear every
-- document's HTTP validators and content hash so the next refresh fetches
-- each file in full (no 304) and re-chunks it. Chunks are left in place:
-- the refresh replaces them, and a failed refresh keeps serving the old ones.
UPDATE `resource_documents` SET `etag` = NULL, `last_modified` = NULL, `content_hash` = '';
