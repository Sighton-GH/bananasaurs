CREATE TABLE `channel_read_scope` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`scope_kind` text DEFAULT 'channel' NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_read_scope_guild_id_snowflake" CHECK(("channel_read_scope"."guild_id" NOT GLOB '*[^0-9]*' AND length("channel_read_scope"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "channel_read_scope_channel_id_snowflake" CHECK(("channel_read_scope"."channel_id" NOT GLOB '*[^0-9]*' AND length("channel_read_scope"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "channel_read_scope_scope_kind" CHECK("channel_read_scope"."scope_kind" IN ('channel','category'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `channel_read_seeds` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`seeded_at` integer NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_read_seeds_guild_id_snowflake" CHECK(("channel_read_seeds"."guild_id" NOT GLOB '*[^0-9]*' AND length("channel_read_seeds"."guild_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
ALTER TABLE `archive_channels` ADD `collecting` integer DEFAULT 1 NOT NULL CONSTRAINT "archive_channels_collecting" CHECK("archive_channels"."collecting" IN (0,1));
