PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assistant_reminders` (
	`guild_id` text NOT NULL,
	`reminder_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`text` text NOT NULL,
	`due_at` integer NOT NULL,
	`next_attempt_at` integer,
	`claimed_at` integer,
	`created_at` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`dedupe_key` text NOT NULL,
	`failure_reason` text,
	`mentions_json` text DEFAULT '{"userIds":[],"roleIds":[],"everyone":false,"here":false}' NOT NULL,
	`recurrence_json` text,
	`context` text,
	`delivered_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer,
	`origin` text DEFAULT 'assistant' NOT NULL,
	PRIMARY KEY(`guild_id`, `reminder_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_reminders_guild_id_snowflake" CHECK(("__new_assistant_reminders"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_reminders"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_reminders_creator_snowflake" CHECK(("__new_assistant_reminders"."creator_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_reminders"."creator_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_reminders_destination_snowflake" CHECK(("__new_assistant_reminders"."destination_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_reminders"."destination_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_reminders_status" CHECK("__new_assistant_reminders"."status" IN ('scheduled','delivering','delivered','cancelled','failed')),
	CONSTRAINT "assistant_reminders_origin" CHECK("__new_assistant_reminders"."origin" IN ('assistant','mcp'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_assistant_reminders`("guild_id", "reminder_id", "creator_id", "destination_id", "text", "due_at", "next_attempt_at", "claimed_at", "created_at", "status", "dedupe_key", "failure_reason", "mentions_json", "recurrence_json", "context", "delivered_count", "updated_at", "origin") SELECT "guild_id", "reminder_id", "creator_id", "destination_id", "text", "due_at", "next_attempt_at", "claimed_at", "created_at", "status", "dedupe_key", "failure_reason", "mentions_json", "recurrence_json", "context", "delivered_count", "updated_at", 'assistant' FROM `assistant_reminders`;--> statement-breakpoint
DROP TABLE `assistant_reminders`;--> statement-breakpoint
ALTER TABLE `__new_assistant_reminders` RENAME TO `assistant_reminders`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `assistant_reminders_due` ON `assistant_reminders` (`guild_id`,`status`,`due_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_reminders_dedupe` ON `assistant_reminders` (`guild_id`,`dedupe_key`);