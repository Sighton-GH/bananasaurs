CREATE TABLE `assistant_model_chain` (
	`position` integer PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider`) REFERENCES `assistant_providers`(`provider`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_model_chain_position" CHECK("assistant_model_chain"."position" BETWEEN 0 AND 5),
	CONSTRAINT "assistant_model_chain_provider" CHECK("assistant_model_chain"."provider" IN ('gemini','openrouter','nvidia-nim'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `assistant_providers` (
	`provider` text PRIMARY KEY NOT NULL,
	`api_key_enc` text,
	`cost_class` text DEFAULT 'unknown' NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "assistant_providers_provider" CHECK("assistant_providers"."provider" IN ('gemini','openrouter','nvidia-nim')),
	CONSTRAINT "assistant_providers_cost_class" CHECK("assistant_providers"."cost_class" IN ('free','paid','unknown')),
	CONSTRAINT "assistant_providers_enabled_bool" CHECK("assistant_providers"."enabled" IN (0,1))
) STRICT;
--> statement-breakpoint
ALTER TABLE `assistant_provider_config` ADD `github_token_enc` text;
--> statement-breakpoint
INSERT INTO assistant_providers (provider, api_key_enc, cost_class, enabled, updated_at)
  SELECT provider, api_key_enc, cost_class, enabled, updated_at FROM assistant_provider_config
  WHERE config_id = 'active' AND provider <> 'off';
--> statement-breakpoint
INSERT INTO assistant_model_chain (position, provider, model, updated_at)
  SELECT 0, provider, model, updated_at FROM assistant_provider_config
  WHERE config_id = 'active' AND provider <> 'off' AND model IS NOT NULL;
--> statement-breakpoint
INSERT INTO assistant_model_chain (position, provider, model, updated_at)
  SELECT 1 + CAST(j.key AS INTEGER), c.provider, j.value, c.updated_at
  FROM assistant_provider_config c, json_each(c.fallback_models_json) j
  WHERE c.config_id = 'active' AND c.provider <> 'off' AND c.model IS NOT NULL AND CAST(j.key AS INTEGER) < 5;