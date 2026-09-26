CREATE TABLE `assistant_model_calls` (
	`call_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key_id` text NOT NULL,
	`model` text NOT NULL,
	`at` integer NOT NULL,
	`guild_id` text NOT NULL,
	FOREIGN KEY (`key_id`) REFERENCES `assistant_provider_keys`(`key_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_model_calls_guild_id_snowflake" CHECK(("assistant_model_calls"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_model_calls"."guild_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE INDEX `assistant_model_calls_key_model_at` ON `assistant_model_calls` (`key_id`,`model`,`at`);--> statement-breakpoint
CREATE TABLE `instance_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	CONSTRAINT "instance_settings_key_length" CHECK(length("instance_settings"."key") BETWEEN 1 AND 64)
) STRICT;
--> statement-breakpoint
ALTER TABLE `assistant_model_chain` ADD `rpm_limit` integer;--> statement-breakpoint
ALTER TABLE `assistant_model_chain` ADD `rpd_limit` integer;--> statement-breakpoint
ALTER TABLE `resource_documents` ADD `error_code` text;