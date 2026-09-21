PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_archive_channels` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`scope_kind` text DEFAULT 'channel' NOT NULL,
	`include_threads` integer DEFAULT 1 NOT NULL,
	`threads_found` integer,
	`threads_done` integer DEFAULT 0 NOT NULL,
	`attachment_policy` text DEFAULT 'none' NOT NULL,
	`enabled_at` integer NOT NULL,
	`cursor_message_id` text,
	`backfill_state` text DEFAULT 'pending' NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "archive_channels_guild_id_snowflake" CHECK(("__new_archive_channels"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_archive_channels"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_channels_channel_id_snowflake" CHECK(("__new_archive_channels"."channel_id" NOT GLOB '*[^0-9]*' AND length("__new_archive_channels"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "archive_channels_scope_kind" CHECK("__new_archive_channels"."scope_kind" IN ('channel','category')),
	CONSTRAINT "archive_channels_include_threads_bool" CHECK("__new_archive_channels"."include_threads" IN (0,1)),
	CONSTRAINT "archive_channels_attachment_policy" CHECK("__new_archive_channels"."attachment_policy" IN ('none','bytes')),
	CONSTRAINT "archive_channels_backfill_state" CHECK("__new_archive_channels"."backfill_state" IN ('pending','running','done'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_archive_channels`("guild_id", "channel_id", "scope_kind", "include_threads", "threads_found", "threads_done", "attachment_policy", "enabled_at", "cursor_message_id", "backfill_state") SELECT "guild_id", "channel_id", 'channel', 1, NULL, 0, "attachment_policy", "enabled_at", "cursor_message_id", "backfill_state" FROM `archive_channels`;--> statement-breakpoint
DROP TABLE `archive_channels`;--> statement-breakpoint
ALTER TABLE `__new_archive_channels` RENAME TO `archive_channels`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `archive_messages` ADD `thread_id` text;--> statement-breakpoint
CREATE INDEX `archive_messages_thread_created` ON `archive_messages` (`guild_id`,`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_mcp_send_allowlist` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`scope_kind` text DEFAULT 'channel' NOT NULL,
	`added_by_account_id` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mcp_send_allowlist_guild_id_snowflake" CHECK(("__new_mcp_send_allowlist"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_mcp_send_allowlist"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mcp_send_allowlist_channel_id_snowflake" CHECK(("__new_mcp_send_allowlist"."channel_id" NOT GLOB '*[^0-9]*' AND length("__new_mcp_send_allowlist"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mcp_send_allowlist_scope_kind" CHECK("__new_mcp_send_allowlist"."scope_kind" IN ('channel','category'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_mcp_send_allowlist`("guild_id", "channel_id", "scope_kind", "added_by_account_id", "added_at") SELECT "guild_id", "channel_id", 'channel', "added_by_account_id", "added_at" FROM `mcp_send_allowlist`;--> statement-breakpoint
DROP TABLE `mcp_send_allowlist`;--> statement-breakpoint
ALTER TABLE `__new_mcp_send_allowlist` RENAME TO `mcp_send_allowlist`;--> statement-breakpoint
CREATE TABLE `__new_mod_case_events` (
	`guild_id` text NOT NULL,
	`event_id` text NOT NULL,
	`case_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`member_id` text NOT NULL,
	`channel_id` text,
	`at` integer NOT NULL,
	`matched_category` text NOT NULL,
	`matched_snippet` text NOT NULL,
	`action_taken` text NOT NULL,
	`escalation_action` text,
	`refusal_reason` text,
	`actor_id` text,
	`trace` text,
	`fixture_id` text,
	PRIMARY KEY(`guild_id`, `event_id`),
	FOREIGN KEY (`guild_id`,`case_id`) REFERENCES `mod_cases`(`guild_id`,`case_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mod_case_events_guild_id_snowflake" CHECK(("__new_mod_case_events"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_mod_case_events"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mod_case_events_member_id_snowflake" CHECK(("__new_mod_case_events"."member_id" NOT GLOB '*[^0-9]*' AND length("__new_mod_case_events"."member_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mod_case_events_channel_id_snowflake" CHECK(("__new_mod_case_events"."channel_id" IS NULL OR ("__new_mod_case_events"."channel_id" NOT GLOB '*[^0-9]*' AND length("__new_mod_case_events"."channel_id") BETWEEN 17 AND 20))),
	CONSTRAINT "mod_case_events_action_taken" CHECK("__new_mod_case_events"."action_taken" IN (
        'deleted','deleted_and_escalated','escalation_refused','escalation_failed',
        'escalation_dry_run','escalation_skipped','would_delete','delete_failed',
        'delete_blocked_killswitch','delete_blocked_breaker','delete_blocked_dry_run',
        'delete_blocked_guild_unknown',
        'warned','note','evidence_added','purged','purge_refused','purge_failed',
        'manual_applied',
        'native_blocked','native_alerted','native_timeout','native_blocked_interaction')),
	CONSTRAINT "mod_case_events_escalation_action" CHECK("__new_mod_case_events"."escalation_action" IS NULL OR "__new_mod_case_events"."escalation_action" IN ('timeout','kick','ban','unban')),
	CONSTRAINT "mod_case_events_refusal_reason" CHECK("__new_mod_case_events"."refusal_reason" IS NULL OR "__new_mod_case_events"."refusal_reason" IN
        ('unauthorized','guild-unknown','killswitch','breaker-open','rate-cap','discord-owner','role-above-bot')),
	CONSTRAINT "mod_case_events_actor_id_snowflake" CHECK(("__new_mod_case_events"."actor_id" IS NULL OR ("__new_mod_case_events"."actor_id" NOT GLOB '*[^0-9]*' AND length("__new_mod_case_events"."actor_id") BETWEEN 17 AND 20)))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_mod_case_events`("guild_id", "event_id", "case_id", "rule_id", "member_id", "channel_id", "at", "matched_category", "matched_snippet", "action_taken", "escalation_action", "refusal_reason", "actor_id", "trace", "fixture_id") SELECT "guild_id", "event_id", "case_id", "rule_id", "member_id", NULL, "at", "matched_category", "matched_snippet", "action_taken", "escalation_action", "refusal_reason", "actor_id", "trace", "fixture_id" FROM `mod_case_events`;--> statement-breakpoint
DROP TABLE `mod_case_events`;--> statement-breakpoint
ALTER TABLE `__new_mod_case_events` RENAME TO `mod_case_events`;