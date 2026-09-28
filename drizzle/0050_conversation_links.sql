CREATE TABLE `assistant_conversation_links` (
	`guild_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`linked_conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `conversation_id`, `linked_conversation_id`, `kind`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guild_id`,`conversation_id`) REFERENCES `assistant_conversations`(`guild_id`,`conversation_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guild_id`,`linked_conversation_id`) REFERENCES `assistant_conversations`(`guild_id`,`conversation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_conversation_links_guild_id_snowflake" CHECK(("assistant_conversation_links"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_conversation_links"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_conversation_links_not_self" CHECK("assistant_conversation_links"."conversation_id" <> "assistant_conversation_links"."linked_conversation_id"),
	CONSTRAINT "assistant_conversation_links_kind" CHECK("assistant_conversation_links"."kind" IN ('same-channel','thread-parent','recalled'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `assistant_conversation_links_linked` ON `assistant_conversation_links` (`guild_id`,`linked_conversation_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assistant_conversation_turns` (
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
	`join_rule` text,
	PRIMARY KEY(`guild_id`, `turn_id`),
	FOREIGN KEY (`guild_id`,`conversation_id`) REFERENCES `assistant_conversations`(`guild_id`,`conversation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_conversation_turns_guild_id_snowflake" CHECK(("__new_assistant_conversation_turns"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_conversation_turns"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_conversation_turns_author_id_snowflake" CHECK(("__new_assistant_conversation_turns"."author_id" IS NULL OR ("__new_assistant_conversation_turns"."author_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_conversation_turns"."author_id") BETWEEN 17 AND 20))),
	CONSTRAINT "assistant_conversation_turns_role" CHECK("__new_assistant_conversation_turns"."role" IN ('user','assistant','quote')),
	CONSTRAINT "assistant_conversation_turns_feedback" CHECK(("__new_assistant_conversation_turns"."feedback" IS NULL OR "__new_assistant_conversation_turns"."feedback" IN ('up','down'))),
	CONSTRAINT "assistant_conversation_turns_join_rule" CHECK(("__new_assistant_conversation_turns"."join_rule" IS NULL OR "__new_assistant_conversation_turns"."join_rule" IN ('reply-to-bot','reply-to-turn','follow-up','thread','channel-follow-up','quoted-reply','reply-to-unknown-bot-message','new-topic','fresh')))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_assistant_conversation_turns`("guild_id", "conversation_id", "turn_id", "at", "role", "author_id", "author_name", "text", "trace_id", "feedback", "join_rule") SELECT "guild_id", "conversation_id", "turn_id", "at", "role", "author_id", "author_name", "text", "trace_id", "feedback", NULL FROM `assistant_conversation_turns`;--> statement-breakpoint
DROP TABLE `assistant_conversation_turns`;--> statement-breakpoint
ALTER TABLE `__new_assistant_conversation_turns` RENAME TO `assistant_conversation_turns`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `assistant_conversation_turns_conversation` ON `assistant_conversation_turns` (`guild_id`,`conversation_id`,`at`);