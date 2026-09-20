PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_archive_channels` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`scope_kind` text DEFAULT 'channel' NOT NULL,
	`derived_from` text,
	`include_threads` integer DEFAULT 1 NOT NULL,
	`threads_found` integer,
	`threads_done` integer DEFAULT 0 NOT NULL,
	`attachment_policy` text DEFAULT 'none' NOT NULL,
	`enabled_at` integer NOT NULL,
	`cursor_message_id` text,
	`backfill_state` text DEFAULT 'pending' NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "archive_channels_guild_id_snowflake" CHECK(("__new_archive_channels"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_archive_channels"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_channels_channel_id_snowflake" CHECK(("__new_archive_channels"."channel_id" NOT GLOB '*[^0-9]*' AND length("__new_archive_channels"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_channels_scope_kind" CHECK("__new_archive_channels"."scope_kind" IN ('channel','category','derived')),
	CONSTRAINT "archive_channels_derived_from_snowflake" CHECK(("__new_archive_channels"."derived_from" IS NULL OR ("__new_archive_channels"."derived_from" NOT GLOB '*[^0-9]*' AND length("__new_archive_channels"."derived_from") BETWEEN 17 AND 20))),
	CONSTRAINT "archive_channels_include_threads_bool" CHECK("__new_archive_channels"."include_threads" IN (0,1)),
	CONSTRAINT "archive_channels_attachment_policy" CHECK("__new_archive_channels"."attachment_policy" IN ('none','bytes')),
	CONSTRAINT "archive_channels_backfill_state" CHECK("__new_archive_channels"."backfill_state" IN ('pending','running','done'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_archive_channels`("guild_id", "channel_id", "scope_kind", "derived_from", "include_threads", "threads_found", "threads_done", "attachment_policy", "enabled_at", "cursor_message_id", "backfill_state") SELECT "guild_id", "channel_id", "scope_kind", NULL, "include_threads", "threads_found", "threads_done", "attachment_policy", "enabled_at", "cursor_message_id", "backfill_state" FROM `archive_channels`;--> statement-breakpoint
DROP TABLE `archive_channels`;--> statement-breakpoint
ALTER TABLE `__new_archive_channels` RENAME TO `archive_channels`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_archive_messages` (
	`guild_id` text NOT NULL,
	`message_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`thread_id` text,
	`author_id` text,
	`content` text,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	`retention_class` text DEFAULT 'default' NOT NULL,
	`case_id` text,
	`content_purged_at` integer,
	PRIMARY KEY(`guild_id`, `message_id`),
	FOREIGN KEY (`guild_id`,`channel_id`) REFERENCES `archive_channels`(`guild_id`,`channel_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "archive_messages_guild_id_snowflake" CHECK(("__new_archive_messages"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_archive_messages"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_messages_message_id_snowflake" CHECK(("__new_archive_messages"."message_id" NOT GLOB '*[^0-9]*' AND length("__new_archive_messages"."message_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_messages_channel_id_snowflake" CHECK(("__new_archive_messages"."channel_id" NOT GLOB '*[^0-9]*' AND length("__new_archive_messages"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_messages_thread_id_snowflake" CHECK(("__new_archive_messages"."thread_id" IS NULL OR ("__new_archive_messages"."thread_id" NOT GLOB '*[^0-9]*' AND length("__new_archive_messages"."thread_id") BETWEEN 17 AND 20))),
	CONSTRAINT "archive_messages_retention_class" CHECK("__new_archive_messages"."retention_class" IN ('default','case','preserve'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_archive_messages`("guild_id", "message_id", "channel_id", "thread_id", "author_id", "content", "created_at", "edited_at", "deleted_at", "retention_class", "case_id", "content_purged_at") SELECT "guild_id", "message_id", "channel_id", "thread_id", "author_id", "content", "created_at", "edited_at", "deleted_at", "retention_class", "case_id", "content_purged_at" FROM `archive_messages`;--> statement-breakpoint
DROP TABLE `archive_messages`;--> statement-breakpoint
ALTER TABLE `__new_archive_messages` RENAME TO `archive_messages`;--> statement-breakpoint
CREATE INDEX `archive_messages_channel_created` ON `archive_messages` (`guild_id`,`channel_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `archive_messages_thread_created` ON `archive_messages` (`guild_id`,`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `archive_messages_deleted` ON `archive_messages` (`guild_id`,`deleted_at`);--> statement-breakpoint
-- The table rebuild above drops archive_messages' triggers with the old table
-- (SQLite drops triggers on DROP TABLE), and the INSERT ... SELECT assigns
-- fresh rowids, so the hand-written FTS5 external-content index from
-- 0020_archive_fts.sql (ADR 0049) would silently stop tracking content and
-- point at stale rowids. Re-attach the triggers and rebuild the index.
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
