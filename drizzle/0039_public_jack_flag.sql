CREATE TABLE `assistant_provider_keys` (
	`key_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`label` text NOT NULL,
	`api_key_enc` text NOT NULL,
	`cost_class` text DEFAULT 'unknown' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "assistant_provider_keys_provider" CHECK("assistant_provider_keys"."provider" IN ('gemini','openrouter','nvidia-nim')),
	CONSTRAINT "assistant_provider_keys_cost_class" CHECK("assistant_provider_keys"."cost_class" IN ('free','paid','unknown')),
	CONSTRAINT "assistant_provider_keys_enabled_bool" CHECK("assistant_provider_keys"."enabled" IN (0,1)),
	CONSTRAINT "assistant_provider_keys_label_length" CHECK(length("assistant_provider_keys"."label") BETWEEN 1 AND 60)
) STRICT;
--> statement-breakpoint
-- Task 6b data copy (hand edit — the only allowed one, plus the SELECT fix
-- below): one `assistant_providers` row with a key becomes one keys row,
-- `key_id = 'key_' || provider`. A provider row with no key has nothing to
-- seal into a key, so it is left out here and its chain rows are left out
-- below; those rows never resolved to anything usable (they were always
-- `skip: 'no-key'`), so nothing working is lost.
INSERT INTO `assistant_provider_keys` (`key_id`, `provider`, `label`, `api_key_enc`, `cost_class`, `enabled`, `created_at`, `updated_at`)
  SELECT 'key_' || `provider`, `provider`,
    CASE `provider` WHEN 'gemini' THEN 'Gemini' WHEN 'openrouter' THEN 'OpenRouter' WHEN 'nvidia-nim' THEN 'NVIDIA NIM' END,
    `api_key_enc`, `cost_class`, `enabled`, `updated_at`, `updated_at`
  FROM `assistant_providers`
  WHERE `api_key_enc` IS NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assistant_model_chain` (
	`position` integer PRIMARY KEY NOT NULL,
	`key_id` text NOT NULL,
	`model` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`key_id`) REFERENCES `assistant_provider_keys`(`key_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_model_chain_position" CHECK("__new_assistant_model_chain"."position" BETWEEN 0 AND 5)
) STRICT;
--> statement-breakpoint
-- Hand-corrected (drizzle-kit generated this INSERT selecting a `key_id`
-- column that only exists on the *new* table — it cannot know to derive it
-- from the old `provider` column, so that line is replaced here, same as
-- M5-D7). Only chain rows whose provider was copied to a key above get one;
-- the rest have no key to reference and are dropped with the same
-- justification as above.
INSERT INTO `__new_assistant_model_chain`("position", "key_id", "model", "updated_at")
  SELECT "position", 'key_' || "provider", "model", "updated_at"
  FROM `assistant_model_chain`
  WHERE "provider" IN (SELECT `provider` FROM `assistant_providers` WHERE `api_key_enc` IS NOT NULL);
--> statement-breakpoint
DROP TABLE `assistant_model_chain`;--> statement-breakpoint
ALTER TABLE `__new_assistant_model_chain` RENAME TO `assistant_model_chain`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_model_chain_key_model` ON `assistant_model_chain` (`key_id`,`model`);--> statement-breakpoint
-- Moved to the end (generated position was right after creating
-- `assistant_provider_keys`): both copies above still need to read from
-- `assistant_providers`, so it can only be dropped once they are done.
DROP TABLE `assistant_providers`;
