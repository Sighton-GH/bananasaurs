CREATE TABLE `message_delete_runs` (
	`guild_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`author_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`claimed_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `actor_user_id`, `author_id`, `channel_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_delete_runs_guild_id_snowflake" CHECK(("message_delete_runs"."guild_id" NOT GLOB '*[^0-9]*' AND length("message_delete_runs"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "message_delete_runs_actor_user_id_snowflake" CHECK(("message_delete_runs"."actor_user_id" NOT GLOB '*[^0-9]*' AND length("message_delete_runs"."actor_user_id") BETWEEN 17 AND 20)),
	CONSTRAINT "message_delete_runs_author_id_snowflake" CHECK(("message_delete_runs"."author_id" NOT GLOB '*[^0-9]*' AND length("message_delete_runs"."author_id") BETWEEN 17 AND 20)),
	CONSTRAINT "message_delete_runs_channel_id_snowflake" CHECK(("message_delete_runs"."channel_id" NOT GLOB '*[^0-9]*' AND length("message_delete_runs"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "message_delete_runs_claimed_count_nonnegative" CHECK("message_delete_runs"."claimed_count" >= 0)
) STRICT;
