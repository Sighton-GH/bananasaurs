CREATE TABLE `assistant_traces` (
	`guild_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`at` integer NOT NULL,
	`user_id` text NOT NULL,
	`behaviour_id` text NOT NULL,
	`outcome` text NOT NULL,
	`conversation_id` text,
	`duration_ms` integer NOT NULL,
	`total_tokens` integer,
	`body_json` text NOT NULL,
	PRIMARY KEY(`guild_id`, `trace_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_traces_guild_id_snowflake" CHECK(("assistant_traces"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_traces"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_traces_user_id_snowflake" CHECK(("assistant_traces"."user_id" NOT GLOB '*[^0-9]*' AND length("assistant_traces"."user_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_traces_outcome" CHECK("assistant_traces"."outcome" IN ('answered','refused','failed'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `assistant_traces_recent` ON `assistant_traces` (`guild_id`,`at`);--> statement-breakpoint
CREATE INDEX `assistant_traces_conversation` ON `assistant_traces` (`guild_id`,`conversation_id`);