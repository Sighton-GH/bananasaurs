CREATE TABLE `automod_fixture_attachments` (
	`guild_id` text NOT NULL,
	`fixture_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text,
	`size_bytes` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `fixture_id`, `ordinal`),
	FOREIGN KEY (`guild_id`,`fixture_id`) REFERENCES `automod_fixtures`(`guild_id`,`fixture_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "automod_fixture_attachments_guild_id_snowflake" CHECK(("automod_fixture_attachments"."guild_id" NOT GLOB '*[^0-9]*' AND length("automod_fixture_attachments"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "automod_fixture_attachments_ordinal_nonnegative" CHECK("automod_fixture_attachments"."ordinal" >= 0),
	CONSTRAINT "automod_fixture_attachments_size_nonnegative" CHECK("automod_fixture_attachments"."size_bytes" >= 0)
) STRICT;
