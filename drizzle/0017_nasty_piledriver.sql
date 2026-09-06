PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_guilds` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`killswitch` integer DEFAULT 0 NOT NULL,
	`dry_run` integer DEFAULT 1 NOT NULL,
	`role_rate_per_min` integer DEFAULT 20 NOT NULL,
	`reconcile_budget` integer DEFAULT 25 NOT NULL,
	`breaker_threshold` integer DEFAULT 5 NOT NULL,
	`breaker_state` text DEFAULT 'closed' NOT NULL,
	`breaker_tripped_at` integer,
	`breaker_reason` text,
	`automod_testing_mode` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "guilds_guild_id_snowflake" CHECK(("__new_guilds"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_guilds"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "guilds_breaker_state" CHECK("__new_guilds"."breaker_state" IN ('closed','open')),
	CONSTRAINT "guilds_enabled_bool" CHECK("__new_guilds"."enabled" IN (0,1)),
	CONSTRAINT "guilds_killswitch_bool" CHECK("__new_guilds"."killswitch" IN (0,1)),
	CONSTRAINT "guilds_dry_run_bool" CHECK("__new_guilds"."dry_run" IN (0,1)),
	CONSTRAINT "guilds_positive_limits" CHECK("__new_guilds"."role_rate_per_min" > 0 AND "__new_guilds"."reconcile_budget" > 0 AND "__new_guilds"."breaker_threshold" > 0),
	CONSTRAINT "guilds_automod_testing_mode_bool" CHECK("__new_guilds"."automod_testing_mode" IN (0,1))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_guilds`("guild_id", "name", "enabled", "killswitch", "dry_run", "role_rate_per_min", "reconcile_budget", "breaker_threshold", "breaker_state", "breaker_tripped_at", "breaker_reason", "automod_testing_mode", "created_at", "updated_at") SELECT "guild_id", "name", "enabled", "killswitch", "dry_run", "role_rate_per_min", "reconcile_budget", "breaker_threshold", "breaker_state", "breaker_tripped_at", "breaker_reason", "automod_testing_mode", "created_at", "updated_at" FROM `guilds`;--> statement-breakpoint
DROP TABLE `guilds`;--> statement-breakpoint
ALTER TABLE `__new_guilds` RENAME TO `guilds`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_mod_rules` (
	`guild_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`mode` text DEFAULT 'test' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`observe_started_at` integer,
	`legacy_rule_ref` text,
	`enforce_signed_off_by` text,
	`enforce_signed_off_at` integer,
	`cutover_state` text DEFAULT 'not_started' NOT NULL,
	`counts_as_violation` integer DEFAULT 1 NOT NULL,
	`max_false_positive_rate` real DEFAULT 0.05 NOT NULL,
	`min_reviewed_matches` integer DEFAULT 20 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `rule_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mod_rules_guild_id_snowflake" CHECK(("__new_mod_rules"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_mod_rules"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mod_rules_kind" CHECK("__new_mod_rules"."kind" IN ('keyword_filter','regex','invite','link_domain','mention_spam','rapid_spam','duplicate_message','caps','attachment_type','emoji')),
	CONSTRAINT "mod_rules_mode" CHECK("__new_mod_rules"."mode" IN ('test','observe','enforce')),
	CONSTRAINT "mod_rules_enabled_bool" CHECK("__new_mod_rules"."enabled" IN (0,1)),
	CONSTRAINT "mod_rules_cutover_state" CHECK("__new_mod_rules"."cutover_state" IN ('not_started','observing','ready','cutover','rolled_back')),
	CONSTRAINT "mod_rules_counts_as_violation_bool" CHECK("__new_mod_rules"."counts_as_violation" IN (0,1)),
	CONSTRAINT "mod_rules_max_false_positive_rate_range" CHECK("__new_mod_rules"."max_false_positive_rate" BETWEEN 0 AND 1),
	CONSTRAINT "mod_rules_min_reviewed_matches_range" CHECK("__new_mod_rules"."min_reviewed_matches" >= 0)
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_mod_rules`("guild_id", "rule_id", "kind", "name", "config", "mode", "enabled", "observe_started_at", "legacy_rule_ref", "enforce_signed_off_by", "enforce_signed_off_at", "cutover_state", "counts_as_violation", "max_false_positive_rate", "min_reviewed_matches", "created_at", "updated_at") SELECT "guild_id", "rule_id", "kind", "name", "config", "mode", "enabled", "observe_started_at", "legacy_rule_ref", "enforce_signed_off_by", "enforce_signed_off_at", "cutover_state", "counts_as_violation", "max_false_positive_rate", "min_reviewed_matches", "created_at", "updated_at" FROM `mod_rules`;--> statement-breakpoint
DROP TABLE `mod_rules`;--> statement-breakpoint
ALTER TABLE `__new_mod_rules` RENAME TO `mod_rules`;