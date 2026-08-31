CREATE TABLE `mod_case_events` (
	`guild_id` text NOT NULL,
	`event_id` text NOT NULL,
	`case_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`member_id` text NOT NULL,
	`at` integer NOT NULL,
	`matched_category` text NOT NULL,
	`matched_snippet` text NOT NULL,
	`action_taken` text NOT NULL,
	`escalation_action` text,
	`refusal_reason` text,
	PRIMARY KEY(`guild_id`, `event_id`),
	FOREIGN KEY (`guild_id`,`case_id`) REFERENCES `mod_cases`(`guild_id`,`case_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mod_case_events_guild_id_snowflake" CHECK(("mod_case_events"."guild_id" NOT GLOB '*[^0-9]*' AND length("mod_case_events"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mod_case_events_member_id_snowflake" CHECK(("mod_case_events"."member_id" NOT GLOB '*[^0-9]*' AND length("mod_case_events"."member_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mod_case_events_action_taken" CHECK("mod_case_events"."action_taken" IN ('deleted','deleted_and_escalated','escalation_refused')),
	CONSTRAINT "mod_case_events_escalation_action" CHECK("mod_case_events"."escalation_action" IS NULL OR "mod_case_events"."escalation_action" IN ('timeout','kick')),
	CONSTRAINT "mod_case_events_refusal_reason" CHECK("mod_case_events"."refusal_reason" IS NULL OR "mod_case_events"."refusal_reason" IN
        ('unauthorized','guild-unknown','killswitch','breaker-open','rate-cap','discord-owner','role-above-bot'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `mod_cases` (
	`guild_id` text NOT NULL,
	`case_id` text NOT NULL,
	`member_id` text NOT NULL,
	`opened_at` integer NOT NULL,
	`violation_count` integer DEFAULT 0 NOT NULL,
	`escalation_tier` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	PRIMARY KEY(`guild_id`, `case_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mod_cases_guild_id_snowflake" CHECK(("mod_cases"."guild_id" NOT GLOB '*[^0-9]*' AND length("mod_cases"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mod_cases_member_id_snowflake" CHECK(("mod_cases"."member_id" NOT GLOB '*[^0-9]*' AND length("mod_cases"."member_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mod_cases_status" CHECK("mod_cases"."status" IN ('open','closed')),
	CONSTRAINT "mod_cases_violation_count_nonnegative" CHECK("mod_cases"."violation_count" >= 0),
	CONSTRAINT "mod_cases_escalation_tier_nonnegative" CHECK("mod_cases"."escalation_tier" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `mod_cases_open_per_member` ON `mod_cases` (`guild_id`,`member_id`) WHERE "mod_cases"."status" = 'open';--> statement-breakpoint
CREATE TABLE `mod_rule_exemptions` (
	`guild_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`exempt_type` text NOT NULL,
	`exempt_id` text NOT NULL,
	PRIMARY KEY(`guild_id`, `rule_id`, `exempt_type`, `exempt_id`),
	FOREIGN KEY (`guild_id`,`rule_id`) REFERENCES `mod_rules`(`guild_id`,`rule_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mod_rule_exemptions_guild_id_snowflake" CHECK(("mod_rule_exemptions"."guild_id" NOT GLOB '*[^0-9]*' AND length("mod_rule_exemptions"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mod_rule_exemptions_exempt_id_snowflake" CHECK(("mod_rule_exemptions"."exempt_id" NOT GLOB '*[^0-9]*' AND length("mod_rule_exemptions"."exempt_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mod_rule_exemptions_type" CHECK("mod_rule_exemptions"."exempt_type" IN ('role','channel'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `mod_rules` (
	`guild_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`mode` text DEFAULT 'test' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `rule_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mod_rules_guild_id_snowflake" CHECK(("mod_rules"."guild_id" NOT GLOB '*[^0-9]*' AND length("mod_rules"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mod_rules_kind" CHECK("mod_rules"."kind" IN ('keyword_filter')),
	CONSTRAINT "mod_rules_mode" CHECK("mod_rules"."mode" IN ('test','observe','enforce')),
	CONSTRAINT "mod_rules_enabled_bool" CHECK("mod_rules"."enabled" IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `word_allowlist` (
	`guild_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`phrase` text NOT NULL,
	PRIMARY KEY(`guild_id`, `rule_id`, `phrase`),
	FOREIGN KEY (`guild_id`,`rule_id`) REFERENCES `mod_rules`(`guild_id`,`rule_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "word_allowlist_guild_id_snowflake" CHECK(("word_allowlist"."guild_id" NOT GLOB '*[^0-9]*' AND length("word_allowlist"."guild_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `word_categories` (
	`guild_id` text NOT NULL,
	`category_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`name` text NOT NULL,
	`default_action` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`guild_id`, `category_id`),
	FOREIGN KEY (`guild_id`,`rule_id`) REFERENCES `mod_rules`(`guild_id`,`rule_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "word_categories_guild_id_snowflake" CHECK(("word_categories"."guild_id" NOT GLOB '*[^0-9]*' AND length("word_categories"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "word_categories_default_action" CHECK("word_categories"."default_action" IN ('log_only','delete','delete_and_case')),
	CONSTRAINT "word_categories_enabled_bool" CHECK("word_categories"."enabled" IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `word_terms` (
	`guild_id` text NOT NULL,
	`term_id` text NOT NULL,
	`category_id` text NOT NULL,
	`text` text NOT NULL,
	`action_override` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`guild_id`, `term_id`),
	FOREIGN KEY (`guild_id`,`category_id`) REFERENCES `word_categories`(`guild_id`,`category_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "word_terms_guild_id_snowflake" CHECK(("word_terms"."guild_id" NOT GLOB '*[^0-9]*' AND length("word_terms"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "word_terms_action_override" CHECK("word_terms"."action_override" IS NULL OR "word_terms"."action_override" IN ('log_only','delete','delete_and_case')),
	CONSTRAINT "word_terms_enabled_bool" CHECK("word_terms"."enabled" IN (0,1))
) STRICT;
