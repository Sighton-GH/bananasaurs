CREATE TABLE `assistant_provider_config` (
	`config_id` text PRIMARY KEY DEFAULT 'active' NOT NULL,
	`provider` text DEFAULT 'off' NOT NULL,
	`model` text,
	`api_key_enc` text,
	`enabled` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "assistant_provider_config_provider" CHECK("assistant_provider_config"."provider" IN ('off','gemini','openrouter','nvidia-nim')),
	CONSTRAINT "assistant_provider_config_enabled_bool" CHECK("assistant_provider_config"."enabled" IN (0,1))
) STRICT;
