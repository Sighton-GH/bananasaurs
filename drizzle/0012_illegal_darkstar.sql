CREATE TABLE `automod_fixtures` (
	`guild_id` text NOT NULL,
	`fixture_id` text NOT NULL,
	`content` text NOT NULL,
	`author_id` text,
	`label` text DEFAULT 'unlabelled' NOT NULL,
	`source` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `fixture_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "automod_fixtures_guild_id_snowflake" CHECK(("automod_fixtures"."guild_id" NOT GLOB '*[^0-9]*' AND length("automod_fixtures"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "automod_fixtures_author_id_snowflake" CHECK(("automod_fixtures"."author_id" IS NULL OR ("automod_fixtures"."author_id" NOT GLOB '*[^0-9]*' AND length("automod_fixtures"."author_id") BETWEEN 17 AND 20))),
	CONSTRAINT "automod_fixtures_label" CHECK("automod_fixtures"."label" IN ('should_match','should_not_match','unlabelled')),
	CONSTRAINT "automod_fixtures_source" CHECK("automod_fixtures"."source" IN ('observed','handwritten')),
	CONSTRAINT "automod_fixtures_observed_has_author" CHECK(("automod_fixtures"."source" = 'observed' AND "automod_fixtures"."author_id" IS NOT NULL)
        OR ("automod_fixtures"."source" = 'handwritten' AND "automod_fixtures"."author_id" IS NULL))
) STRICT;
--> statement-breakpoint
CREATE INDEX `automod_fixtures_replay` ON `automod_fixtures` (`guild_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `automod_fixtures_by_author` ON `automod_fixtures` (`guild_id`,`author_id`);--> statement-breakpoint
CREATE TABLE `mod_match_reviews` (
	`guild_id` text NOT NULL,
	`event_id` text NOT NULL,
	`verdict` text NOT NULL,
	`reviewed_by` text NOT NULL,
	`reviewed_at` integer NOT NULL,
	`note` text,
	PRIMARY KEY(`guild_id`, `event_id`),
	FOREIGN KEY (`guild_id`,`event_id`) REFERENCES `mod_case_events`(`guild_id`,`event_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mod_match_reviews_guild_id_snowflake" CHECK(("mod_match_reviews"."guild_id" NOT GLOB '*[^0-9]*' AND length("mod_match_reviews"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mod_match_reviews_verdict" CHECK("mod_match_reviews"."verdict" IN ('false_positive','true_positive','unclear'))
) STRICT;
--> statement-breakpoint
ALTER TABLE `mod_case_events` ADD `trace` text;--> statement-breakpoint
ALTER TABLE `mod_case_events` ADD `fixture_id` text;