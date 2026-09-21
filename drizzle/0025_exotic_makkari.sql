CREATE TABLE `assistant_decisions` (
	`guild_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`requester_id` text NOT NULL,
	`provenance` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `decision_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_decisions_guild_id_snowflake" CHECK(("assistant_decisions"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_decisions"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_decisions_requester_id_snowflake" CHECK(("assistant_decisions"."requester_id" NOT GLOB '*[^0-9]*' AND length("assistant_decisions"."requester_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_decisions_kind" CHECK("assistant_decisions"."kind" IN ('decision','review-plan')),
	CONSTRAINT "assistant_decisions_status" CHECK("assistant_decisions"."status" IN ('draft','reviewed','saved'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `assistant_skill_grants` (
	`guild_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`role_ids_json` text DEFAULT '[]' NOT NULL,
	`user_ids_json` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `skill_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_skill_grants_guild_id_snowflake" CHECK(("assistant_skill_grants"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_skill_grants"."guild_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `assistant_tickets` (
	`guild_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`behaviour_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`requester_id` text NOT NULL,
	`summary` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`dedupe_key` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `ticket_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_tickets_guild_id_snowflake" CHECK(("assistant_tickets"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_tickets"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_tickets_channel_id_snowflake" CHECK(("assistant_tickets"."channel_id" NOT GLOB '*[^0-9]*' AND length("assistant_tickets"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_tickets_requester_id_snowflake" CHECK(("assistant_tickets"."requester_id" NOT GLOB '*[^0-9]*' AND length("assistant_tickets"."requester_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_tickets_status" CHECK("assistant_tickets"."status" IN ('open','claimed','resolved'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_tickets_dedupe` ON `assistant_tickets` (`guild_id`,`dedupe_key`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assistant_behaviours` (
	`guild_id` text NOT NULL,
	`behaviour_id` text NOT NULL,
	`surface` text NOT NULL,
	`mention_role_id` text,
	`name` text NOT NULL,
	`system_prompt` text NOT NULL,
	`prompt_version` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`skill_ids_json` text DEFAULT '[]' NOT NULL,
	`caller_role_ids_json` text DEFAULT '[]' NOT NULL,
	`ticket_channel_id` text,
	`reviewer_role_ids_json` text DEFAULT '[]' NOT NULL,
	`resource_ids_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `behaviour_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_behaviours_surface" CHECK("__new_assistant_behaviours"."surface" IN ('bananasaurs','it-services','help','direct-command')),
	CONSTRAINT "assistant_behaviours_guild_id_snowflake" CHECK(("__new_assistant_behaviours"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_behaviours"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_behaviours_enabled_bool" CHECK("__new_assistant_behaviours"."enabled" IN (0,1)),
	CONSTRAINT "assistant_behaviours_mention_snowflake" CHECK(("__new_assistant_behaviours"."mention_role_id" IS NULL OR ("__new_assistant_behaviours"."mention_role_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_behaviours"."mention_role_id") BETWEEN 17 AND 20))),
	CONSTRAINT "assistant_behaviours_ticket_channel_snowflake" CHECK(("__new_assistant_behaviours"."ticket_channel_id" IS NULL OR ("__new_assistant_behaviours"."ticket_channel_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_behaviours"."ticket_channel_id") BETWEEN 17 AND 20)))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_assistant_behaviours`("guild_id", "behaviour_id", "surface", "mention_role_id", "name", "system_prompt", "prompt_version", "enabled", "skill_ids_json", "caller_role_ids_json", "ticket_channel_id", "reviewer_role_ids_json", "resource_ids_json", "created_at", "updated_at") SELECT "guild_id", "behaviour_id", "surface", "mention_role_id", "name", "system_prompt", 1, "enabled", "skill_ids_json", '[]', NULL, '[]', "resource_ids_json", "created_at", "updated_at" FROM `assistant_behaviours`;--> statement-breakpoint
DROP TABLE `assistant_behaviours`;--> statement-breakpoint
ALTER TABLE `__new_assistant_behaviours` RENAME TO `assistant_behaviours`;--> statement-breakpoint
PRAGMA foreign_keys=ON;