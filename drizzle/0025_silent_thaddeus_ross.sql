PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assistant_behaviours` (
	`guild_id` text NOT NULL,
	`behaviour_id` text NOT NULL,
	`surface` text NOT NULL,
	`mention_role_id` text,
	`name` text NOT NULL,
	`system_prompt` text NOT NULL,
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
INSERT INTO `__new_assistant_behaviours`("guild_id", "behaviour_id", "surface", "mention_role_id", "name", "system_prompt", "enabled", "skill_ids_json", "caller_role_ids_json", "ticket_channel_id", "reviewer_role_ids_json", "resource_ids_json", "created_at", "updated_at") SELECT "guild_id", "behaviour_id", "surface", "mention_role_id", "name", "system_prompt", "enabled", "skill_ids_json", '[]', NULL, '[]', "resource_ids_json", "created_at", "updated_at" FROM `assistant_behaviours`;--> statement-breakpoint
DROP TABLE `assistant_behaviours`;--> statement-breakpoint
ALTER TABLE `__new_assistant_behaviours` RENAME TO `assistant_behaviours`;--> statement-breakpoint
PRAGMA foreign_keys=ON;