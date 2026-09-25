PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assistant_settings` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`log_channel_id` text,
	`conversation_retention_days` integer DEFAULT 182,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_settings_guild_id_snowflake" CHECK(("__new_assistant_settings"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_settings"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_settings_log_channel_snowflake" CHECK(("__new_assistant_settings"."log_channel_id" IS NULL OR ("__new_assistant_settings"."log_channel_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_settings"."log_channel_id") BETWEEN 17 AND 20))),
	CONSTRAINT "assistant_settings_conversation_retention_days" CHECK(("__new_assistant_settings"."conversation_retention_days" IS NULL OR "__new_assistant_settings"."conversation_retention_days" IN (61,182,365)))
) STRICT;
--> statement-breakpoint
-- Hand-corrected (drizzle-kit generated this INSERT selecting a
-- `conversation_retention_days` column that only exists on the *new* table —
-- the old `assistant_settings` has no such column, so the statement fails
-- with "no such column" on any real database; same class of fix as 0039).
-- Existing rows carry the default 182 (6 months); every CHECK, FK and column
-- above is exactly as generated, only the SELECT list changed.
INSERT INTO `__new_assistant_settings`("guild_id", "log_channel_id", "conversation_retention_days", "updated_at") SELECT "guild_id", "log_channel_id", 182, "updated_at" FROM `assistant_settings`;--> statement-breakpoint
DROP TABLE `assistant_settings`;--> statement-breakpoint
ALTER TABLE `__new_assistant_settings` RENAME TO `assistant_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;