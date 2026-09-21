CREATE TABLE `assistant_behaviours` (
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
	CONSTRAINT "assistant_behaviours_surface" CHECK("assistant_behaviours"."surface" IN ('bananasaurs','it-services','help','direct-command')),
	CONSTRAINT "assistant_behaviours_guild_id_snowflake" CHECK(("assistant_behaviours"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_behaviours"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_behaviours_enabled_bool" CHECK("assistant_behaviours"."enabled" IN (0,1)),
	CONSTRAINT "assistant_behaviours_mention_snowflake" CHECK(("assistant_behaviours"."mention_role_id" IS NULL OR ("assistant_behaviours"."mention_role_id" NOT GLOB '*[^0-9]*' AND length("assistant_behaviours"."mention_role_id") BETWEEN 17 AND 20))),
	CONSTRAINT "assistant_behaviours_ticket_channel_snowflake" CHECK(("assistant_behaviours"."ticket_channel_id" IS NULL OR ("assistant_behaviours"."ticket_channel_id" NOT GLOB '*[^0-9]*' AND length("assistant_behaviours"."ticket_channel_id") BETWEEN 17 AND 20)))
) STRICT;
--> statement-breakpoint
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
CREATE TABLE `assistant_reminders` (
	`guild_id` text NOT NULL,
	`reminder_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`text` text NOT NULL,
	`due_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`dedupe_key` text NOT NULL,
	`failure_reason` text,
	PRIMARY KEY(`guild_id`, `reminder_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_reminders_guild_id_snowflake" CHECK(("assistant_reminders"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_reminders"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_reminders_creator_snowflake" CHECK(("assistant_reminders"."creator_id" NOT GLOB '*[^0-9]*' AND length("assistant_reminders"."creator_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_reminders_destination_snowflake" CHECK(("assistant_reminders"."destination_id" NOT GLOB '*[^0-9]*' AND length("assistant_reminders"."destination_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_reminders_status" CHECK("assistant_reminders"."status" IN ('scheduled','delivering','delivered','cancelled','failed'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `assistant_reminders_due` ON `assistant_reminders` (`guild_id`,`status`,`due_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_reminders_dedupe` ON `assistant_reminders` (`guild_id`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `assistant_resources` (
	`guild_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`reviewed_at` integer NOT NULL,
	`last_fetched_at` integer,
	`fetch_status` text DEFAULT 'pending' NOT NULL,
	`content` text,
	PRIMARY KEY(`guild_id`, `resource_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_resources_kind" CHECK("assistant_resources"."kind" IN ('website','document','discord-channel','repository','note')),
	CONSTRAINT "assistant_resources_guild_id_snowflake" CHECK(("assistant_resources"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_resources"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_resources_enabled_bool" CHECK("assistant_resources"."enabled" IN (0,1)),
	CONSTRAINT "assistant_resources_fetch_status" CHECK("assistant_resources"."fetch_status" IN ('pending','ok','failed','blocked'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `assistant_skill_activity` (
	`guild_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`at` integer NOT NULL,
	`behaviour_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`outcome` text NOT NULL,
	`detail` text,
	PRIMARY KEY(`guild_id`, `activity_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_skill_activity_guild_id_snowflake" CHECK(("assistant_skill_activity"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_skill_activity"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_skill_activity_actor_snowflake" CHECK(("assistant_skill_activity"."actor_id" NOT GLOB '*[^0-9]*' AND length("assistant_skill_activity"."actor_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE INDEX `assistant_skill_activity_recent` ON `assistant_skill_activity` (`guild_id`,`at`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `assistant_tickets_dedupe` ON `assistant_tickets` (`guild_id`,`dedupe_key`);