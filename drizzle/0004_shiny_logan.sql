CREATE TABLE `account_capabilities` (
	`guild_id` text NOT NULL,
	`account_id` text NOT NULL,
	`capability` text NOT NULL,
	`granted_at` integer NOT NULL,
	`granted_by` text NOT NULL,
	PRIMARY KEY(`guild_id`, `account_id`, `capability`),
	FOREIGN KEY (`guild_id`,`account_id`) REFERENCES `account_guild_access`(`guild_id`,`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "account_capabilities_guild_id_snowflake" CHECK(("account_capabilities"."guild_id" NOT GLOB '*[^0-9]*' AND length("account_capabilities"."guild_id") BETWEEN 17 AND 20))
) STRICT;
