ALTER TABLE `mod_rules` ADD `observe_started_at` integer;--> statement-breakpoint
ALTER TABLE `mod_rules` ADD `legacy_rule_ref` text;--> statement-breakpoint
ALTER TABLE `mod_rules` ADD `enforce_signed_off_by` text;--> statement-breakpoint
ALTER TABLE `mod_rules` ADD `enforce_signed_off_at` integer;