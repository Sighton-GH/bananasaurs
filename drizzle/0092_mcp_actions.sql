CREATE TABLE `mcp_actions` (
	`guild_id` text NOT NULL,
	`action_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`kind` text NOT NULL,
	`cap_group` text NOT NULL,
	`args_hash` text NOT NULL,
	`status` text NOT NULL,
	`token_id` text NOT NULL,
	`target_channel_id` text,
	`result_message_id` text,
	`result_thread_id` text,
	`undo_json` text,
	`undone_by_action_id` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mcp_actions_guild_id_snowflake" CHECK(("mcp_actions"."guild_id" NOT GLOB '*[^0-9]*' AND length("mcp_actions"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mcp_actions_target_channel_id_snowflake" CHECK(("mcp_actions"."target_channel_id" IS NULL OR ("mcp_actions"."target_channel_id" NOT GLOB '*[^0-9]*' AND length("mcp_actions"."target_channel_id") BETWEEN 17 AND 20))),
	CONSTRAINT "mcp_actions_result_message_id_snowflake" CHECK(("mcp_actions"."result_message_id" IS NULL OR ("mcp_actions"."result_message_id" NOT GLOB '*[^0-9]*' AND length("mcp_actions"."result_message_id") BETWEEN 17 AND 20))),
	CONSTRAINT "mcp_actions_result_thread_id_snowflake" CHECK(("mcp_actions"."result_thread_id" IS NULL OR ("mcp_actions"."result_thread_id" NOT GLOB '*[^0-9]*' AND length("mcp_actions"."result_thread_id") BETWEEN 17 AND 20))),
	CONSTRAINT "mcp_actions_cap_group" CHECK("mcp_actions"."cap_group" IN ('message','edit','thread','pin_react')),
	CONSTRAINT "mcp_actions_status" CHECK("mcp_actions"."status" IN ('claimed','done','dry_run','failed'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `mcp_actions_cap_created` ON `mcp_actions` (`guild_id`,`cap_group`,`created_at`);--> statement-breakpoint
CREATE INDEX `mcp_actions_target_created` ON `mcp_actions` (`guild_id`,`target_channel_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_actions_idempotency_once` ON `mcp_actions` (`guild_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_actions_action_once` ON `mcp_actions` (`guild_id`,`action_id`);--> statement-breakpoint
CREATE TABLE `mcp_private_threads` (
	`guild_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`parent_channel_id` text NOT NULL,
	`created_action_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mcp_private_threads_guild_id_snowflake" CHECK(("mcp_private_threads"."guild_id" NOT GLOB '*[^0-9]*' AND length("mcp_private_threads"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mcp_private_threads_thread_id_snowflake" CHECK(("mcp_private_threads"."thread_id" NOT GLOB '*[^0-9]*' AND length("mcp_private_threads"."thread_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mcp_private_threads_parent_channel_id_snowflake" CHECK(("mcp_private_threads"."parent_channel_id" NOT GLOB '*[^0-9]*' AND length("mcp_private_threads"."parent_channel_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_private_threads_once` ON `mcp_private_threads` (`guild_id`,`thread_id`);--> statement-breakpoint
CREATE TABLE `mcp_role_allowlist` (
	`guild_id` text NOT NULL,
	`role_id` text NOT NULL,
	`purpose` text NOT NULL,
	`added_by_account_id` text NOT NULL,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mcp_role_allowlist_guild_id_snowflake" CHECK(("mcp_role_allowlist"."guild_id" NOT GLOB '*[^0-9]*' AND length("mcp_role_allowlist"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mcp_role_allowlist_role_id_snowflake" CHECK(("mcp_role_allowlist"."role_id" NOT GLOB '*[^0-9]*' AND length("mcp_role_allowlist"."role_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mcp_role_allowlist_purpose" CHECK("mcp_role_allowlist"."purpose" IN ('grant','ping'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_role_allowlist_once` ON `mcp_role_allowlist` (`guild_id`,`role_id`,`purpose`);--> statement-breakpoint
CREATE TABLE `mcp_role_policy` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`grant_mode` text DEFAULT 'below-bot' NOT NULL,
	`ping_mode` text DEFAULT 'below-bot' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mcp_role_policy_guild_id_snowflake" CHECK(("mcp_role_policy"."guild_id" NOT GLOB '*[^0-9]*' AND length("mcp_role_policy"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mcp_role_policy_grant_mode" CHECK("mcp_role_policy"."grant_mode" IN ('below-bot','allowlist')),
	CONSTRAINT "mcp_role_policy_ping_mode" CHECK("mcp_role_policy"."ping_mode" IN ('below-bot','allowlist'))
) STRICT;
--> statement-breakpoint
INSERT INTO `mcp_actions` (`guild_id`, `action_id`, `idempotency_key`, `kind`, `cap_group`, `args_hash`, `status`, `token_id`, `target_channel_id`, `result_message_id`, `created_at`, `completed_at`)
SELECT `guild_id`, 'legacy:' || `idempotency_key`, `idempotency_key`, 'message.send', 'message', `content_hash`,
	CASE `outcome` WHEN 'dry_run' THEN 'dry_run' ELSE 'done' END,
	`token_id`, `channel_id`, `message_id`, `sent_at`, `sent_at`
FROM `mcp_sends`;
