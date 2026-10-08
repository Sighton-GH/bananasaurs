CREATE TABLE `assistant_run_events` (
	`guild_id` text NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`model` text,
	`key_id` text,
	`ok` integer,
	`code` text,
	`ms` integer,
	`tokens` integer,
	`cost_usd` real,
	`data_json` text NOT NULL,
	PRIMARY KEY(`guild_id`, `run_id`, `seq`),
	FOREIGN KEY (`guild_id`,`run_id`) REFERENCES `assistant_runs`(`guild_id`,`run_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_run_events_guild_id_snowflake" CHECK(("assistant_run_events"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_run_events"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_run_events_ok" CHECK("assistant_run_events"."ok" IS NULL OR "assistant_run_events"."ok" IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE INDEX `assistant_run_events_kind` ON `assistant_run_events` (`guild_id`,`kind`,`at`);--> statement-breakpoint
CREATE TABLE `assistant_runs` (
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
	CONSTRAINT "assistant_runs_guild_id_snowflake" CHECK(("assistant_runs"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_runs"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_runs_user_id_snowflake" CHECK(("assistant_runs"."user_id" NOT GLOB '*[^0-9]*' AND length("assistant_runs"."user_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_runs_channel_id_snowflake" CHECK(("assistant_runs"."channel_id" IS NULL OR ("assistant_runs"."channel_id" NOT GLOB '*[^0-9]*' AND length("assistant_runs"."channel_id") BETWEEN 17 AND 20))),
	CONSTRAINT "assistant_runs_state" CHECK("assistant_runs"."state" IN ('queued','running','retry-wait','answered','refused','failed')),
	CONSTRAINT "assistant_runs_stage" CHECK("assistant_runs"."stage" IN ('queued','starting','conversation','context','calling-model','running-tool','retry-wait','delivering','done')),
	CONSTRAINT "assistant_runs_source" CHECK("assistant_runs"."source" IN ('mention','slash-command','dashboard-test'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `assistant_runs_state` ON `assistant_runs` (`guild_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `assistant_runs_conversation` ON `assistant_runs` (`guild_id`,`conversation_id`);