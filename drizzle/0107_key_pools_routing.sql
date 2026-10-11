CREATE TABLE `assistant_key_cooldowns` (
	`key_id` text NOT NULL,
	`model` text NOT NULL,
	`until_at` integer NOT NULL,
	`reason` text NOT NULL,
	`set_at` integer NOT NULL,
	`learned_per_day` integer,
	`learned_per_minute` integer,
	FOREIGN KEY (`key_id`) REFERENCES `assistant_provider_keys`(`key_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_key_cooldowns_reason_length" CHECK(length("assistant_key_cooldowns"."reason") BETWEEN 1 AND 60)
) STRICT;
--> statement-breakpoint
CREATE INDEX `assistant_key_cooldowns_key` ON `assistant_key_cooldowns` (`key_id`,`model`,`until_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_key_cooldowns_key_model` ON `assistant_key_cooldowns` (`key_id`,`model`);--> statement-breakpoint
ALTER TABLE `assistant_model_chain` ADD `pool` text DEFAULT 'key' NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_model_chain` ADD `tier` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_provider_keys` ADD `project` text;--> statement-breakpoint
ALTER TABLE `assistant_provider_keys` ADD `fingerprint` text;--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_provider_keys_fingerprint` ON `assistant_provider_keys` (`fingerprint`);--> statement-breakpoint
INSERT INTO `provider_eligibility` (`provider`, `trains_on_input`, `evidence_url`, `evidence_clause`, `production_use_allowed`, `reviewed_at`) VALUES ('gemini:free', 'yes', 'https://ai.google.dev/gemini-api/docs/billing', 'Gemini API Additional Terms (effective 2026-03-23): Unpaid Services content may be used to provide, improve and develop Google products and machine learning technologies (owner decision D12, 2026-10-10).', 1, 1791676800000);
--> statement-breakpoint
INSERT INTO `provider_eligibility` (`provider`, `trains_on_input`, `evidence_url`, `evidence_clause`, `production_use_allowed`, `reviewed_at`) VALUES ('gemini:paid', 'no', 'https://cloud.google.com/terms', 'Paid Services on a project with an active billing account: owner-recorded no-training; re-check the current paid terms before changing this (owner decision D12, 2026-10-10).', 1, 1791676800000);
