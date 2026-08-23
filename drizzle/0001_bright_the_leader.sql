DROP INDEX `jobs_dedupe`;--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe` ON `jobs` (`guild_id`,`dedupe_key`) WHERE "jobs"."state" IN ('queued','running');