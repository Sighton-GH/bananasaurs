CREATE TABLE `channel_write_seeds` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`seeded_at` integer NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_write_seeds_guild_id_snowflake" CHECK(("channel_write_seeds"."guild_id" NOT GLOB '*[^0-9]*' AND length("channel_write_seeds"."guild_id") BETWEEN 17 AND 20))
) STRICT;
