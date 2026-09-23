CREATE TABLE `assistant_memories` (
	`guild_id` text NOT NULL,
	`memory_id` text NOT NULL,
	`content` text NOT NULL,
	`subject_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `memory_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_memories_guild_id_snowflake" CHECK(("assistant_memories"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_memories"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_memories_subject_id_snowflake" CHECK(("assistant_memories"."subject_id" IS NULL OR ("assistant_memories"."subject_id" NOT GLOB '*[^0-9]*' AND length("assistant_memories"."subject_id") BETWEEN 17 AND 20)))
) STRICT;
--> statement-breakpoint
CREATE TABLE `assistant_memory_preferences` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`opted_out` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_memory_preferences_guild_id_snowflake" CHECK(("assistant_memory_preferences"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_memory_preferences"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_memory_preferences_user_id_snowflake" CHECK(("assistant_memory_preferences"."user_id" NOT GLOB '*[^0-9]*' AND length("assistant_memory_preferences"."user_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_memory_preferences_opted_out_bool" CHECK("assistant_memory_preferences"."opted_out" IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `assistant_server_cards` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_server_cards_guild_id_snowflake" CHECK(("assistant_server_cards"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_server_cards"."guild_id") BETWEEN 17 AND 20))
) STRICT;
