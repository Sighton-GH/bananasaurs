CREATE TABLE `mcp_send_allowlist` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`added_by_account_id` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mcp_send_allowlist_guild_id_snowflake" CHECK(("mcp_send_allowlist"."guild_id" NOT GLOB '*[^0-9]*' AND length("mcp_send_allowlist"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mcp_send_allowlist_channel_id_snowflake" CHECK(("mcp_send_allowlist"."channel_id" NOT GLOB '*[^0-9]*' AND length("mcp_send_allowlist"."channel_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `mcp_sends` (
	`guild_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`channel_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`message_id` text,
	`token_id` text NOT NULL,
	`sent_at` integer NOT NULL,
	`outcome` text NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mcp_sends_guild_id_snowflake" CHECK(("mcp_sends"."guild_id" NOT GLOB '*[^0-9]*' AND length("mcp_sends"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mcp_sends_channel_id_snowflake" CHECK(("mcp_sends"."channel_id" NOT GLOB '*[^0-9]*' AND length("mcp_sends"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mcp_sends_message_id_snowflake" CHECK(("mcp_sends"."message_id" IS NULL OR ("mcp_sends"."message_id" NOT GLOB '*[^0-9]*' AND length("mcp_sends"."message_id") BETWEEN 17 AND 20))),
	CONSTRAINT "mcp_sends_outcome" CHECK("mcp_sends"."outcome" IN ('sent','dry_run'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `mcp_sends_recent` ON `mcp_sends` (`guild_id`,`sent_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_sends_idempotency_once` ON `mcp_sends` (`guild_id`,`idempotency_key`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_audit_events` (
	`audit_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`at` integer NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`actor_unix_user_claimed` text,
	`via` text,
	`action` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text,
	`batch_id` text,
	`before` text,
	`after` text,
	`dry_run` integer DEFAULT 0 NOT NULL,
	`inferred` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "audit_events_guild_id_snowflake" CHECK(("__new_audit_events"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_audit_events"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "audit_events_actor_type" CHECK("__new_audit_events"."actor_type" IN ('member','owner','operator_cli','dashboard','system','doctor','mcp_operator')),
	CONSTRAINT "audit_events_via" CHECK("__new_audit_events"."via" IS NULL OR "__new_audit_events"."via" IN ('ssh','http','gateway')),
	CONSTRAINT "audit_events_dry_run_bool" CHECK("__new_audit_events"."dry_run" IN (0,1)),
	CONSTRAINT "audit_events_inferred_bool" CHECK("__new_audit_events"."inferred" IN (0,1))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_audit_events`("audit_id", "guild_id", "at", "actor_type", "actor_id", "actor_unix_user_claimed", "via", "action", "subject_type", "subject_id", "batch_id", "before", "after", "dry_run", "inferred") SELECT "audit_id", "guild_id", "at", "actor_type", "actor_id", "actor_unix_user_claimed", "via", "action", "subject_type", "subject_id", "batch_id", "before", "after", "dry_run", "inferred" FROM `audit_events`;--> statement-breakpoint
DROP TABLE `audit_events`;--> statement-breakpoint
ALTER TABLE `__new_audit_events` RENAME TO `audit_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `audit_tail` ON `audit_events` (`guild_id`,"at" desc);