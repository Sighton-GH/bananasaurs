PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assistant_provider_config` (
	`config_id` text PRIMARY KEY DEFAULT 'active' NOT NULL,
	`provider` text DEFAULT 'off' NOT NULL,
	`model` text,
	`api_key_enc` text,
	`enabled` integer DEFAULT 0 NOT NULL,
	`cost_class` text DEFAULT 'unknown' NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "assistant_provider_config_cost_class" CHECK("__new_assistant_provider_config"."cost_class" IN ('free','paid','unknown')),
	CONSTRAINT "assistant_provider_config_provider" CHECK("__new_assistant_provider_config"."provider" IN ('off','gemini','openrouter','nvidia-nim')),
	CONSTRAINT "assistant_provider_config_enabled_bool" CHECK("__new_assistant_provider_config"."enabled" IN (0,1))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_assistant_provider_config`("config_id", "provider", "model", "api_key_enc", "enabled", "cost_class", "updated_at") SELECT "config_id", "provider", "model", "api_key_enc", "enabled", 'unknown', "updated_at" FROM `assistant_provider_config`;--> statement-breakpoint
DROP TABLE `assistant_provider_config`;--> statement-breakpoint
ALTER TABLE `__new_assistant_provider_config` RENAME TO `assistant_provider_config`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `provider_eligibility` ADD `evidence_clause` text;