ALTER TABLE `assistant_conversations` ADD `summary_text` text;--> statement-breakpoint
-- ADR 0049 pattern (ADR 0093): a virtual table cannot be declared in
-- schema.ts, so this file is hand-written. Guild isolation is enforced by
-- the caller joining back to assistant_conversations (which carries guild_id) rather
-- than by a column on the FTS table itself — see repos/conversations.ts.
CREATE VIRTUAL TABLE assistant_conversations_summaries_fts USING fts5(
  summary_text,
  content='assistant_conversations',
  content_rowid='rowid',
  tokenize='porter unicode61'
);--> statement-breakpoint
CREATE TRIGGER assistant_conversations_summaries_fts_ai AFTER INSERT ON assistant_conversations BEGIN
  INSERT INTO assistant_conversations_summaries_fts(rowid, summary_text)
  VALUES (new.rowid, new.summary_text);
END;--> statement-breakpoint
CREATE TRIGGER assistant_conversations_summaries_fts_ad AFTER DELETE ON assistant_conversations BEGIN
  INSERT INTO assistant_conversations_summaries_fts(assistant_conversations_summaries_fts, rowid, summary_text)
  VALUES ('delete', old.rowid, old.summary_text);
END;--> statement-breakpoint
CREATE TRIGGER assistant_conversations_summaries_fts_au AFTER UPDATE OF summary_text ON assistant_conversations BEGIN
  INSERT INTO assistant_conversations_summaries_fts(assistant_conversations_summaries_fts, rowid, summary_text)
  VALUES ('delete', old.rowid, old.summary_text);
  INSERT INTO assistant_conversations_summaries_fts(rowid, summary_text)
  VALUES (new.rowid, new.summary_text);
END;--> statement-breakpoint
INSERT INTO assistant_conversations_summaries_fts(assistant_conversations_summaries_fts) VALUES('rebuild');