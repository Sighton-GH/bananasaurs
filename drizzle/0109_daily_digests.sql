CREATE TABLE `assistant_daily_digests` (
	`guild_id` text NOT NULL,
	`day` text NOT NULL,
	`summary_json` text NOT NULL,
	`summary_text` text NOT NULL,
	`proposals_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `day`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_daily_digests_guild_id_snowflake" CHECK(("assistant_daily_digests"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_daily_digests"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_daily_digests_day" CHECK(length("assistant_daily_digests"."day") = 10)
) STRICT;
--> statement-breakpoint
CREATE INDEX `assistant_daily_digests_recent` ON `assistant_daily_digests` (`guild_id`,`day`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assistant_runs` (
	`guild_id` text NOT NULL,
	`run_id` text NOT NULL,
	`conversation_id` text,
	`trace_id` text,
	`user_id` text NOT NULL,
	`channel_id` text,
	`behaviour_id` text NOT NULL,
	`source` text NOT NULL,
	`state` text NOT NULL,
	`stage` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`queued_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`retry_at` integer,
	`model` text,
	`key_label` text,
	`error_code` text,
	`total_tokens` integer,
	PRIMARY KEY(`guild_id`, `run_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_runs_guild_id_snowflake" CHECK(("__new_assistant_runs"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_runs"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_runs_user_id_snowflake" CHECK(("__new_assistant_runs"."user_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_runs"."user_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_runs_channel_id_snowflake" CHECK(("__new_assistant_runs"."channel_id" IS NULL OR ("__new_assistant_runs"."channel_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_runs"."channel_id") BETWEEN 17 AND 20))),
	CONSTRAINT "assistant_runs_state" CHECK("__new_assistant_runs"."state" IN ('queued','running','retry-wait','answered','refused','failed')),
	CONSTRAINT "assistant_runs_stage" CHECK("__new_assistant_runs"."stage" IN ('queued','starting','conversation','context','calling-model','running-tool','retry-wait','delivering','done')),
	CONSTRAINT "assistant_runs_source" CHECK("__new_assistant_runs"."source" IN ('mention','slash-command','dashboard-test','daily-digest'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_assistant_runs`("guild_id", "run_id", "conversation_id", "trace_id", "user_id", "channel_id", "behaviour_id", "source", "state", "stage", "attempt", "queued_at", "updated_at", "started_at", "finished_at", "retry_at", "model", "key_label", "error_code", "total_tokens") SELECT "guild_id", "run_id", "conversation_id", "trace_id", "user_id", "channel_id", "behaviour_id", "source", "state", "stage", "attempt", "queued_at", "updated_at", "started_at", "finished_at", "retry_at", "model", "key_label", "error_code", "total_tokens" FROM `assistant_runs`;--> statement-breakpoint
DROP TABLE `assistant_runs`;--> statement-breakpoint
ALTER TABLE `__new_assistant_runs` RENAME TO `assistant_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `assistant_runs_state` ON `assistant_runs` (`guild_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `assistant_runs_conversation` ON `assistant_runs` (`guild_id`,`conversation_id`);