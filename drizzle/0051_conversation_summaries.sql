ALTER TABLE `assistant_conversations` ADD `summary_json` text;--> statement-breakpoint
ALTER TABLE `assistant_conversations` ADD `summary_through_at` integer;--> statement-breakpoint
ALTER TABLE `assistant_conversations` ADD `summary_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_conversations` ADD `summary_updated_at` integer;