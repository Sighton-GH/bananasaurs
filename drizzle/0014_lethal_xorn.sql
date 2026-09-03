CREATE TABLE `automod_invite_allowlist` (
	`guild_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`code` text NOT NULL,
	`label` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `rule_id`, `code`),
	FOREIGN KEY (`guild_id`,`rule_id`) REFERENCES `mod_rules`(`guild_id`,`rule_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "automod_invite_allowlist_guild_id_snowflake" CHECK(("automod_invite_allowlist"."guild_id" NOT GLOB '*[^0-9]*' AND length("automod_invite_allowlist"."guild_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `automod_link_domains` (
	`guild_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`domain` text NOT NULL,
	`list_type` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `rule_id`, `domain`),
	FOREIGN KEY (`guild_id`,`rule_id`) REFERENCES `mod_rules`(`guild_id`,`rule_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "automod_link_domains_guild_id_snowflake" CHECK(("automod_link_domains"."guild_id" NOT GLOB '*[^0-9]*' AND length("automod_link_domains"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "automod_link_domains_list_type" CHECK("automod_link_domains"."list_type" IN ('allow','deny'))
) STRICT;
