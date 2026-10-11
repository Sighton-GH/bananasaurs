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
	CONSTRAINT "assistant_provider_config_search_source" CHECK("__new_assistant_provider_config"."search_source" IN ('brave','tavily','parallel')),
	CONSTRAINT "assistant_provider_config_provider" CHECK("__new_assistant_provider_config"."provider" IN ('off','gemini','openrouter','nvidia-nim')),
	CONSTRAINT "assistant_provider_config_enabled_bool" CHECK("__new_assistant_provider_config"."enabled" IN (0,1))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_assistant_provider_config`("config_id", "provider", "model", "api_key_enc", "enabled", "cost_class", "fallback_models_json", "search_api_key_enc", "search_enabled", "search_source", "github_token_enc", "updated_at") SELECT "config_id", "provider", "model", "api_key_enc", "enabled", "cost_class", "fallback_models_json", "search_api_key_enc", "search_enabled", "search_source", "github_token_enc", "updated_at" FROM `assistant_provider_config`;--> statement-breakpoint
DROP TABLE `assistant_provider_config`;--> statement-breakpoint
ALTER TABLE `__new_assistant_provider_config` RENAME TO `assistant_provider_config`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_assistant_search_keys` (
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
	CONSTRAINT "assistant_search_keys_source" CHECK("__new_assistant_search_keys"."source" IN ('brave','tavily','parallel')),
	CONSTRAINT "assistant_search_keys_label_length" CHECK(length("__new_assistant_search_keys"."label") BETWEEN 1 AND 60),
	CONSTRAINT "assistant_search_keys_enabled_bool" CHECK("__new_assistant_search_keys"."enabled" IN (0,1)),
	CONSTRAINT "assistant_search_keys_monthly_limit" CHECK("__new_assistant_search_keys"."monthly_limit" IS NULL OR "__new_assistant_search_keys"."monthly_limit" BETWEEN 1 AND 1000000),
	CONSTRAINT "assistant_search_keys_daily_limit" CHECK("__new_assistant_search_keys"."daily_limit" IS NULL OR "__new_assistant_search_keys"."daily_limit" BETWEEN 1 AND 1000000)
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_assistant_search_keys`("key_id", "source", "label", "api_key_enc", "enabled", "position", "monthly_limit", "daily_limit", "created_at", "updated_at") SELECT "key_id", "source", "label", "api_key_enc", "enabled", "position", "monthly_limit", "daily_limit", "created_at", "updated_at" FROM `assistant_search_keys`;--> statement-breakpoint
DROP TABLE `assistant_search_keys`;--> statement-breakpoint
ALTER TABLE `__new_assistant_search_keys` RENAME TO `assistant_search_keys`;--> statement-breakpoint
ALTER TABLE `assistant_reminders` ADD `style` text DEFAULT 'reminder' NOT NULL;--> statement-breakpoint
INSERT INTO `provider_eligibility` (`provider`, `trains_on_input`, `evidence_url`, `evidence_clause`, `production_use_allowed`, `reviewed_at`) VALUES ('parallel', 'yes', 'https://parallel.ai/terms', 'Customer terms section 4(b): Parallel may use Customer IP, including search queries, to train and improve its models (owner decision D11, 2026-10-10).', 1, 1791676800000);
