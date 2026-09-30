PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	`reply_to_message_id` text,
	`mentioned_role_ids` text,
	`retention_class` text DEFAULT 'default' NOT NULL,
	`case_id` text,
	`content_purged_at` integer,
	PRIMARY KEY(`guild_id`, `message_id`),
	FOREIGN KEY (`guild_id`,`channel_id`) REFERENCES `archive_channels`(`guild_id`,`channel_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "archive_messages_guild_id_snowflake" CHECK(("__new_archive_messages"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_archive_messages"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_messages_message_id_snowflake" CHECK(("__new_archive_messages"."message_id" NOT GLOB '*[^0-9]*' AND length("__new_archive_messages"."message_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_messages_channel_id_snowflake" CHECK(("__new_archive_messages"."channel_id" NOT GLOB '*[^0-9]*' AND length("__new_archive_messages"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_messages_thread_id_snowflake" CHECK(("__new_archive_messages"."thread_id" IS NULL OR ("__new_archive_messages"."thread_id" NOT GLOB '*[^0-9]*' AND length("__new_archive_messages"."thread_id") BETWEEN 17 AND 20))),
	CONSTRAINT "archive_messages_reply_to_message_id_snowflake" CHECK(("__new_archive_messages"."reply_to_message_id" IS NULL OR ("__new_archive_messages"."reply_to_message_id" NOT GLOB '*[^0-9]*' AND length("__new_archive_messages"."reply_to_message_id") BETWEEN 17 AND 20))),
	CONSTRAINT "archive_messages_retention_class" CHECK("__new_archive_messages"."retention_class" IN ('default','case','preserve'))
);
--> statement-breakpoint
INSERT INTO `__new_archive_messages`("guild_id", "message_id", "channel_id", "thread_id", "author_id", "content", "created_at", "edited_at", "deleted_at", "reply_to_message_id", "mentioned_role_ids", "retention_class", "case_id", "content_purged_at") SELECT "guild_id", "message_id", "channel_id", "thread_id", "author_id", "content", "created_at", "edited_at", "deleted_at", "reply_to_message_id", "mentioned_role_ids", "retention_class", "case_id", "content_purged_at" FROM `archive_messages`;--> statement-breakpoint
DROP TABLE `archive_messages`;--> statement-breakpoint
ALTER TABLE `__new_archive_messages` RENAME TO `archive_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `archive_messages_channel_created` ON `archive_messages` (`guild_id`,`channel_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `archive_messages_thread_created` ON `archive_messages` (`guild_id`,`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `archive_messages_deleted` ON `archive_messages` (`guild_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `archive_messages_author_created` ON `archive_messages` (`guild_id`,`author_id`,`created_at`);