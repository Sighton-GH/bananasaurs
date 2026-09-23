CREATE TABLE `assistant_settings` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`log_channel_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_settings_guild_id_snowflake" CHECK(("assistant_settings"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_settings"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_settings_log_channel_snowflake" CHECK(("assistant_settings"."log_channel_id" IS NULL OR ("assistant_settings"."log_channel_id" NOT GLOB '*[^0-9]*' AND length("assistant_settings"."log_channel_id") BETWEEN 17 AND 20)))
) STRICT;
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assistant_provider_config` (
	`config_id` text PRIMARY KEY DEFAULT 'active' NOT NULL,
	`provider` text DEFAULT 'off' NOT NULL,
	`model` text,
	`api_key_enc` text,
	`enabled` integer DEFAULT 0 NOT NULL,
	`cost_class` text DEFAULT 'unknown' NOT NULL,
	`fallback_model` text,
	`search_api_key_enc` text,
	`search_enabled` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "assistant_provider_config_cost_class" CHECK("__new_assistant_provider_config"."cost_class" IN ('free','paid','unknown')),
	CONSTRAINT "assistant_provider_config_search_enabled_bool" CHECK("__new_assistant_provider_config"."search_enabled" IN (0,1)),
	CONSTRAINT "assistant_provider_config_provider" CHECK("__new_assistant_provider_config"."provider" IN ('off','gemini','openrouter','nvidia-nim')),
	CONSTRAINT "assistant_provider_config_enabled_bool" CHECK("__new_assistant_provider_config"."enabled" IN (0,1))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_assistant_provider_config`("config_id", "provider", "model", "api_key_enc", "enabled", "cost_class", "fallback_model", "search_api_key_enc", "search_enabled", "updated_at") SELECT "config_id", "provider", "model", "api_key_enc", "enabled", "cost_class", NULL, NULL, 0, "updated_at" FROM `assistant_provider_config`;--> statement-breakpoint
DROP TABLE `assistant_provider_config`;--> statement-breakpoint
ALTER TABLE `__new_assistant_provider_config` RENAME TO `assistant_provider_config`;--> statement-breakpoint
PRAGMA foreign_keys=ON;