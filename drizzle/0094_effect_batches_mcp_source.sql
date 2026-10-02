PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_effect_batches` (
	`guild_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`source` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`undone_at` integer,
	PRIMARY KEY(`guild_id`, `batch_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "effect_batches_guild_id_snowflake" CHECK(("__new_effect_batches"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_effect_batches"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "effect_batches_source" CHECK("__new_effect_batches"."source" IN ('interaction','reaction','adoption','reconcile','cli','dashboard','mcp'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_effect_batches`("guild_id", "batch_id", "source", "actor_type", "actor_id", "started_at", "finished_at", "undone_at") SELECT "guild_id", "batch_id", "source", "actor_type", "actor_id", "started_at", "finished_at", "undone_at" FROM `effect_batches`;--> statement-breakpoint
DROP TABLE `effect_batches`;--> statement-breakpoint
ALTER TABLE `__new_effect_batches` RENAME TO `effect_batches`;--> statement-breakpoint
PRAGMA foreign_keys=ON;