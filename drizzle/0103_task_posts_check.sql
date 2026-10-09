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
	`automod_state` text DEFAULT 'off' NOT NULL,
	`task_posts_enabled` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "guilds_guild_id_snowflake" CHECK(("__new_guilds"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_guilds"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "guilds_breaker_state" CHECK("__new_guilds"."breaker_state" IN ('closed','open')),
	CONSTRAINT "guilds_enabled_bool" CHECK("__new_guilds"."enabled" IN (0,1)),
	CONSTRAINT "guilds_killswitch_bool" CHECK("__new_guilds"."killswitch" IN (0,1)),
	CONSTRAINT "guilds_dry_run_bool" CHECK("__new_guilds"."dry_run" IN (0,1)),
	CONSTRAINT "guilds_positive_limits" CHECK("__new_guilds"."role_rate_per_min" > 0 AND "__new_guilds"."reconcile_budget" > 0 AND "__new_guilds"."breaker_threshold" > 0),
	CONSTRAINT "guilds_task_posts_enabled_bool" CHECK("__new_guilds"."task_posts_enabled" IN (0,1)),
	CONSTRAINT "guilds_automod_state" CHECK("__new_guilds"."automod_state" IN ('off','watch','on'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_guilds`("guild_id", "name", "enabled", "killswitch", "dry_run", "role_rate_per_min", "reconcile_budget", "breaker_threshold", "breaker_state", "breaker_tripped_at", "breaker_reason", "automod_state", "task_posts_enabled", "created_at", "updated_at") SELECT "guild_id", "name", "enabled", "killswitch", "dry_run", "role_rate_per_min", "reconcile_budget", "breaker_threshold", "breaker_state", "breaker_tripped_at", "breaker_reason", "automod_state", "task_posts_enabled", "created_at", "updated_at" FROM `guilds`;--> statement-breakpoint
DROP TABLE `guilds`;--> statement-breakpoint
ALTER TABLE `__new_guilds` RENAME TO `guilds`;--> statement-breakpoint
PRAGMA foreign_keys=ON;