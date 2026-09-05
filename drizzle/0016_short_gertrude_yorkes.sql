ALTER TABLE `guilds` ADD `automod_testing_mode` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mod_rules` ADD `cutover_state` text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE `mod_rules` ADD `counts_as_violation` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `mod_rules` ADD `max_false_positive_rate` real DEFAULT 0.05 NOT NULL;--> statement-breakpoint
ALTER TABLE `mod_rules` ADD `min_reviewed_matches` integer DEFAULT 20 NOT NULL;