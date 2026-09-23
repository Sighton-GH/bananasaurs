PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assistant_decisions` (
	`guild_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`requester_id` text NOT NULL,
	`provenance` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `decision_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_decisions_guild_id_snowflake" CHECK(("__new_assistant_decisions"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_decisions"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_decisions_requester_id_snowflake" CHECK(("__new_assistant_decisions"."requester_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_decisions"."requester_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_decisions_kind" CHECK("__new_assistant_decisions"."kind" IN ('decision','review-plan','memory')),
	CONSTRAINT "assistant_decisions_status" CHECK("__new_assistant_decisions"."status" IN ('draft','reviewed','saved'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_assistant_decisions`("guild_id", "decision_id", "kind", "summary", "status", "requester_id", "provenance", "created_at") SELECT "guild_id", "decision_id", "kind", "summary", "status", "requester_id", "provenance", "created_at" FROM `assistant_decisions`;--> statement-breakpoint
DROP TABLE `assistant_decisions`;--> statement-breakpoint
ALTER TABLE `__new_assistant_decisions` RENAME TO `assistant_decisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;