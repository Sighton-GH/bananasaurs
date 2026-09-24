CREATE TABLE `assistant_conversation_messages` (
	`guild_id` text NOT NULL,
	`message_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`guild_id`, `message_id`),
	FOREIGN KEY (`guild_id`,`conversation_id`) REFERENCES `assistant_conversations`(`guild_id`,`conversation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_conversation_messages_guild_id_snowflake" CHECK(("assistant_conversation_messages"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_conversation_messages"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_conversation_messages_message_id_snowflake" CHECK(("assistant_conversation_messages"."message_id" NOT GLOB '*[^0-9]*' AND length("assistant_conversation_messages"."message_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_conversation_messages_role" CHECK("assistant_conversation_messages"."role" IN ('user','assistant'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `assistant_conversation_turns` (
	`guild_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`at` integer NOT NULL,
	`role` text NOT NULL,
	`author_id` text,
	`author_name` text NOT NULL,
	`text` text NOT NULL,
	`trace_id` text,
	`feedback` text,
	PRIMARY KEY(`guild_id`, `turn_id`),
	FOREIGN KEY (`guild_id`,`conversation_id`) REFERENCES `assistant_conversations`(`guild_id`,`conversation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_conversation_turns_guild_id_snowflake" CHECK(("assistant_conversation_turns"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_conversation_turns"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_conversation_turns_author_id_snowflake" CHECK(("assistant_conversation_turns"."author_id" IS NULL OR ("assistant_conversation_turns"."author_id" NOT GLOB '*[^0-9]*' AND length("assistant_conversation_turns"."author_id") BETWEEN 17 AND 20))),
	CONSTRAINT "assistant_conversation_turns_role" CHECK("assistant_conversation_turns"."role" IN ('user','assistant','quote')),
	CONSTRAINT "assistant_conversation_turns_feedback" CHECK(("assistant_conversation_turns"."feedback" IS NULL OR "assistant_conversation_turns"."feedback" IN ('up','down')))
) STRICT;
--> statement-breakpoint
CREATE INDEX `assistant_conversation_turns_conversation` ON `assistant_conversation_turns` (`guild_id`,`conversation_id`,`at`);--> statement-breakpoint
CREATE TABLE `assistant_conversations` (
	`guild_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`behaviour_id` text NOT NULL,
	`started_by` text NOT NULL,
	`title` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`turn_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `conversation_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_conversations_guild_id_snowflake" CHECK(("assistant_conversations"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_conversations"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_conversations_channel_id_snowflake" CHECK(("assistant_conversations"."channel_id" NOT GLOB '*[^0-9]*' AND length("assistant_conversations"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_conversations_started_by_snowflake" CHECK(("assistant_conversations"."started_by" NOT GLOB '*[^0-9]*' AND length("assistant_conversations"."started_by") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_conversations_source" CHECK("assistant_conversations"."source" IN ('discord','dashboard-test')),
	CONSTRAINT "assistant_conversations_status" CHECK("assistant_conversations"."status" IN ('open','ended'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `assistant_conversations_activity` ON `assistant_conversations` (`guild_id`,`last_activity_at`);--> statement-breakpoint
CREATE INDEX `assistant_conversations_author` ON `assistant_conversations` (`guild_id`,`channel_id`,`started_by`,`last_activity_at`);