CREATE TABLE `assistant_search_calls` (
	`call_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key_id` text NOT NULL,
	`at` integer NOT NULL,
	`guild_id` text NOT NULL,
	FOREIGN KEY (`key_id`) REFERENCES `assistant_search_keys`(`key_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_search_calls_guild_id_snowflake" CHECK(("assistant_search_calls"."guild_id" NOT GLOB '*[^0-9]*' AND length("assistant_search_calls"."guild_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE INDEX `assistant_search_calls_key_at` ON `assistant_search_calls` (`key_id`,`at`);--> statement-breakpoint
CREATE TABLE `assistant_search_keys` (
	`key_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`label` text NOT NULL,
	`api_key_enc` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`monthly_limit` integer,
	`daily_limit` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "assistant_search_keys_source" CHECK("assistant_search_keys"."source" IN ('brave','tavily')),
	CONSTRAINT "assistant_search_keys_label_length" CHECK(length("assistant_search_keys"."label") BETWEEN 1 AND 60),
	CONSTRAINT "assistant_search_keys_enabled_bool" CHECK("assistant_search_keys"."enabled" IN (0,1)),
	CONSTRAINT "assistant_search_keys_monthly_limit" CHECK("assistant_search_keys"."monthly_limit" IS NULL OR "assistant_search_keys"."monthly_limit" BETWEEN 1 AND 1000000),
	CONSTRAINT "assistant_search_keys_daily_limit" CHECK("assistant_search_keys"."daily_limit" IS NULL OR "assistant_search_keys"."daily_limit" BETWEEN 1 AND 1000000)
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
	`fallback_models_json` text DEFAULT '[]' NOT NULL,
	`search_api_key_enc` text,
	`search_enabled` integer DEFAULT 0 NOT NULL,
	`search_source` text DEFAULT 'brave' NOT NULL,
	`github_token_enc` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "assistant_provider_config_cost_class" CHECK("__new_assistant_provider_config"."cost_class" IN ('free','paid','unknown')),
	CONSTRAINT "assistant_provider_config_search_enabled_bool" CHECK("__new_assistant_provider_config"."search_enabled" IN (0,1)),
	CONSTRAINT "assistant_provider_config_search_source" CHECK("__new_assistant_provider_config"."search_source" IN ('brave','tavily')),
	CONSTRAINT "assistant_provider_config_provider" CHECK("__new_assistant_provider_config"."provider" IN ('off','gemini','openrouter','nvidia-nim')),
	CONSTRAINT "assistant_provider_config_enabled_bool" CHECK("__new_assistant_provider_config"."enabled" IN (0,1))
) STRICT;
--> statement-breakpoint
-- Hand-corrected (drizzle-kit generated this INSERT selecting a
-- `search_source` column that only exists on the *new* table — it cannot know
-- the added column needs its default, same as 0039's key_id fix): existing
-- rows keep Brave, the ADR 0120 default for installs that predate sources.
INSERT INTO `__new_assistant_provider_config`("config_id", "provider", "model", "api_key_enc", "enabled", "cost_class", "fallback_models_json", "search_api_key_enc", "search_enabled", "search_source", "github_token_enc", "updated_at") SELECT "config_id", "provider", "model", "api_key_enc", "enabled", "cost_class", "fallback_models_json", "search_api_key_enc", "search_enabled", 'brave', "github_token_enc", "updated_at" FROM `assistant_provider_config`;--> statement-breakpoint
DROP TABLE `assistant_provider_config`;--> statement-breakpoint
ALTER TABLE `__new_assistant_provider_config` RENAME TO `assistant_provider_config`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- ADR 0120 data copy (hand edit): the saved Brave key becomes the first Brave search key.
INSERT INTO `assistant_search_keys` (`key_id`, `source`, `label`, `api_key_enc`, `enabled`, `position`, `monthly_limit`, `daily_limit`, `created_at`, `updated_at`)
  SELECT 'skey_brave', 'brave', 'Brave key', `search_api_key_enc`, 1, 0, 1000, NULL, `updated_at`, `updated_at`
  FROM `assistant_provider_config`
  WHERE `search_api_key_enc` IS NOT NULL;