PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assistant_resources` (
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
	`parent_id` text,
	`meta_json` text,
	PRIMARY KEY(`guild_id`, `resource_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_resources_kind" CHECK("__new_assistant_resources"."kind" IN ('website','document','discord-channel','repository','note','github-repo','github-org')),
	CONSTRAINT "assistant_resources_guild_id_snowflake" CHECK(("__new_assistant_resources"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_resources"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_resources_enabled_bool" CHECK("__new_assistant_resources"."enabled" IN (0,1)),
	CONSTRAINT "assistant_resources_fetch_status" CHECK("__new_assistant_resources"."fetch_status" IN ('pending','ok','failed','blocked'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_assistant_resources`("guild_id", "resource_id", "title", "url", "kind", "enabled", "reviewed_at", "last_fetched_at", "fetch_status", "content", "parent_id", "meta_json") SELECT "guild_id", "resource_id", "title", "url", "kind", "enabled", "reviewed_at", "last_fetched_at", "fetch_status", "content", "parent_id", "meta_json" FROM `assistant_resources`;--> statement-breakpoint
DROP TABLE `assistant_resources`;--> statement-breakpoint
ALTER TABLE `__new_assistant_resources` RENAME TO `assistant_resources`;--> statement-breakpoint
PRAGMA foreign_keys=ON;