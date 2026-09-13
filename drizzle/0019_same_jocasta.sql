PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_archive_attachments` (
	`guild_id` text NOT NULL,
	`message_id` text NOT NULL,
	`attachment_id` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text,
	`size` integer NOT NULL,
	`sha256` text,
	`bytes_path` text,
	PRIMARY KEY(`guild_id`, `message_id`, `attachment_id`),
	FOREIGN KEY (`guild_id`,`message_id`) REFERENCES `archive_messages`(`guild_id`,`message_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "archive_attachments_guild_id_snowflake" CHECK(("__new_archive_attachments"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_archive_attachments"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_attachments_message_id_snowflake" CHECK(("__new_archive_attachments"."message_id" NOT GLOB '*[^0-9]*' AND length("__new_archive_attachments"."message_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_attachments_attachment_id_snowflake" CHECK(("__new_archive_attachments"."attachment_id" NOT GLOB '*[^0-9]*' AND length("__new_archive_attachments"."attachment_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_archive_attachments`("guild_id", "message_id", "attachment_id", "filename", "content_type", "size", "sha256", "bytes_path") SELECT "guild_id", "message_id", "attachment_id", "filename", "content_type", "size", "sha256", "bytes_path" FROM `archive_attachments`;--> statement-breakpoint
DROP TABLE `archive_attachments`;--> statement-breakpoint
ALTER TABLE `__new_archive_attachments` RENAME TO `archive_attachments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;