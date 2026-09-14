-- ADR 0049: a virtual table cannot be declared in schema.ts, so this file is hand-written.
CREATE VIRTUAL TABLE archive_messages_fts USING fts5(
  content,
  guild_id UNINDEXED,
  channel_id UNINDEXED,
  message_id UNINDEXED,
  content='archive_messages',
  content_rowid='rowid'
);--> statement-breakpoint
CREATE TRIGGER archive_messages_fts_ai AFTER INSERT ON archive_messages BEGIN
  INSERT INTO archive_messages_fts(rowid, content, guild_id, channel_id, message_id)
  VALUES (new.rowid, new.content, new.guild_id, new.channel_id, new.message_id);
END;--> statement-breakpoint
CREATE TRIGGER archive_messages_fts_ad AFTER DELETE ON archive_messages BEGIN
  INSERT INTO archive_messages_fts(archive_messages_fts, rowid, content, guild_id, channel_id, message_id)
  VALUES ('delete', old.rowid, old.content, old.guild_id, old.channel_id, old.message_id);
END;--> statement-breakpoint
CREATE TRIGGER archive_messages_fts_au AFTER UPDATE OF content ON archive_messages BEGIN
  INSERT INTO archive_messages_fts(archive_messages_fts, rowid, content, guild_id, channel_id, message_id)
  VALUES ('delete', old.rowid, old.content, old.guild_id, old.channel_id, old.message_id);
  INSERT INTO archive_messages_fts(rowid, content, guild_id, channel_id, message_id)
  VALUES (new.rowid, new.content, new.guild_id, new.channel_id, new.message_id);
END;--> statement-breakpoint
INSERT INTO archive_messages_fts(archive_messages_fts) VALUES('rebuild');
