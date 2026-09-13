CREATE TABLE `archive_attachments` (
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
	CONSTRAINT "archive_attachments_guild_id_snowflake" CHECK(("archive_attachments"."guild_id" NOT GLOB '*[^0-9]*' AND length("archive_attachments"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_attachments_message_id_snowflake" CHECK(("archive_attachments"."message_id" NOT GLOB '*[^0-9]*' AND length("archive_attachments"."message_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `archive_channels` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`attachment_policy` text DEFAULT 'none' NOT NULL,
	`enabled_at` integer NOT NULL,
	`cursor_message_id` text,
	`backfill_state` text DEFAULT 'pending' NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "archive_channels_guild_id_snowflake" CHECK(("archive_channels"."guild_id" NOT GLOB '*[^0-9]*' AND length("archive_channels"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_channels_channel_id_snowflake" CHECK(("archive_channels"."channel_id" NOT GLOB '*[^0-9]*' AND length("archive_channels"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_channels_attachment_policy" CHECK("archive_channels"."attachment_policy" IN ('none','bytes')),
	CONSTRAINT "archive_channels_backfill_state" CHECK("archive_channels"."backfill_state" IN ('pending','running','done'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `archive_message_edits` (
	`guild_id` text NOT NULL,
	`message_id` text NOT NULL,
	`edit_seq` integer NOT NULL,
	`content` text,
	`edited_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `message_id`, `edit_seq`),
	FOREIGN KEY (`guild_id`,`message_id`) REFERENCES `archive_messages`(`guild_id`,`message_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "archive_message_edits_guild_id_snowflake" CHECK(("archive_message_edits"."guild_id" NOT GLOB '*[^0-9]*' AND length("archive_message_edits"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_message_edits_message_id_snowflake" CHECK(("archive_message_edits"."message_id" NOT GLOB '*[^0-9]*' AND length("archive_message_edits"."message_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `archive_messages` (
	`guild_id` text NOT NULL,
	`message_id` text NOT NULL,
	`channel_id` text NOT NULL,
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
	CONSTRAINT "archive_messages_guild_id_snowflake" CHECK(("archive_messages"."guild_id" NOT GLOB '*[^0-9]*' AND length("archive_messages"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_messages_message_id_snowflake" CHECK(("archive_messages"."message_id" NOT GLOB '*[^0-9]*' AND length("archive_messages"."message_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_messages_channel_id_snowflake" CHECK(("archive_messages"."channel_id" NOT GLOB '*[^0-9]*' AND length("archive_messages"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_messages_retention_class" CHECK("archive_messages"."retention_class" IN ('default','case','preserve'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `archive_messages_channel_created` ON `archive_messages` (`guild_id`,`channel_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `archive_messages_deleted` ON `archive_messages` (`guild_id`,`deleted_at`);