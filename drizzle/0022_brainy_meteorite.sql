CREATE TABLE `provider_eligibility` (
	`provider` text PRIMARY KEY NOT NULL,
	`trains_on_input` text NOT NULL,
	`evidence_url` text NOT NULL,
	`production_use_allowed` integer NOT NULL,
	`reviewed_at` integer NOT NULL,
	CONSTRAINT "provider_eligibility_trains_on_input" CHECK("provider_eligibility"."trains_on_input" IN ('no','yes','unknown')),
	CONSTRAINT "provider_eligibility_production_use_allowed_bool" CHECK("provider_eligibility"."production_use_allowed" IN (0,1))
) STRICT;
--> statement-breakpoint
-- Ruling M4-D16: the eligibility row is seeded by the migration (versioned,
-- applied exactly once), not by a startup seed. Hand-editing a generated
-- migration to append a seed is the one permitted edit (M2's 0020 precedent).
-- Neither ADR 0044 §7 nor design §8.4 cites a canonical URL — both say only
-- "the settings page" — so the Anthropic data-privacy-controls page is used.
-- reviewed_at is 2026-09-14T00:00:00Z (1789344000000), the date the owner
-- confirmed training is disabled on the account holding the connectors.
INSERT INTO `provider_eligibility` (`provider`, `trains_on_input`, `evidence_url`, `production_use_allowed`, `reviewed_at`) VALUES ('anthropic-consumer-mcp', 'no', 'https://claude.ai/settings/data-privacy-controls', 1, 1789344000000);
