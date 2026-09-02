PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_mod_rules` (
	`guild_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`mode` text DEFAULT 'test' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `rule_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mod_rules_guild_id_snowflake" CHECK(("__new_mod_rules"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_mod_rules"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mod_rules_kind" CHECK("__new_mod_rules"."kind" IN ('keyword_filter','regex','invite','link_domain','mention_spam','rapid_spam','duplicate_message','caps','attachment_type','emoji')),
	CONSTRAINT "mod_rules_mode" CHECK("__new_mod_rules"."mode" IN ('test','observe','enforce')),
	CONSTRAINT "mod_rules_enabled_bool" CHECK("__new_mod_rules"."enabled" IN (0,1))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_mod_rules`("guild_id", "rule_id", "kind", "name", "config", "mode", "enabled", "created_at", "updated_at") SELECT "guild_id", "rule_id", "kind", "name", "config", "mode", "enabled", "created_at", "updated_at" FROM `mod_rules`;--> statement-breakpoint
DROP TABLE `mod_rules`;--> statement-breakpoint
ALTER TABLE `__new_mod_rules` RENAME TO `mod_rules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;