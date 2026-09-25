-- ADR 0049 pattern (ADR 0073): a virtual table cannot be declared in
-- schema.ts, so this file is hand-written. Guild isolation is enforced by
-- the caller joining back to resource_chunks (which carries guild_id) rather
-- than by a column on the FTS table itself — see resource-cache.ts.
CREATE VIRTUAL TABLE resource_chunks_fts USING fts5(
  text,
  heading_path,
  content='resource_chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);--> statement-breakpoint
CREATE TRIGGER resource_chunks_fts_ai AFTER INSERT ON resource_chunks BEGIN
  INSERT INTO resource_chunks_fts(rowid, text, heading_path)
  VALUES (new.rowid, new.text, new.heading_path);
END;--> statement-breakpoint
CREATE TRIGGER resource_chunks_fts_ad AFTER DELETE ON resource_chunks BEGIN
  INSERT INTO resource_chunks_fts(resource_chunks_fts, rowid, text, heading_path)
  VALUES ('delete', old.rowid, old.text, old.heading_path);
END;--> statement-breakpoint
CREATE TRIGGER resource_chunks_fts_au AFTER UPDATE OF text, heading_path ON resource_chunks BEGIN
  INSERT INTO resource_chunks_fts(resource_chunks_fts, rowid, text, heading_path)
  VALUES ('delete', old.rowid, old.text, old.heading_path);
  INSERT INTO resource_chunks_fts(rowid, text, heading_path)
  VALUES (new.rowid, new.text, new.heading_path);
END;--> statement-breakpoint
INSERT INTO resource_chunks_fts(resource_chunks_fts) VALUES('rebuild');
