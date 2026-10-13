CREATE TABLE `task_links` (
	`guild_id` text NOT NULL,
	`task_id` text NOT NULL,
	`position` integer NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	PRIMARY KEY(`guild_id`, `task_id`, `position`),
	FOREIGN KEY (`guild_id`,`task_id`) REFERENCES `club_tasks`(`guild_id`,`task_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_links_guild_snowflake" CHECK(("task_links"."guild_id" NOT GLOB '*[^0-9]*' AND length("task_links"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_links_position" CHECK("task_links"."position" BETWEEN 0 AND 4),
	CONSTRAINT "task_links_label" CHECK(length("task_links"."label") BETWEEN 1 AND 34),
	CONSTRAINT "task_links_url" CHECK("task_links"."url" LIKE 'https://%' AND length("task_links"."url") <= 512)
) STRICT;
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_nudge_slots` (
	`guild_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`task_id` text,
	`team_id` text,
	`kind` text NOT NULL,
	`due_at` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`destination_id` text,
	`message_id` text,
	`payload` text,
	`last_error` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `slot_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_nudge_slot_guild" CHECK(("__new_task_nudge_slots"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_task_nudge_slots"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_nudge_slot_destination" CHECK(("__new_task_nudge_slots"."destination_id" IS NULL OR ("__new_task_nudge_slots"."destination_id" NOT GLOB '*[^0-9]*' AND length("__new_task_nudge_slots"."destination_id") BETWEEN 17 AND 20))),
	CONSTRAINT "task_nudge_slot_message" CHECK(("__new_task_nudge_slots"."message_id" IS NULL OR ("__new_task_nudge_slots"."message_id" NOT GLOB '*[^0-9]*' AND length("__new_task_nudge_slots"."message_id") BETWEEN 17 AND 20))),
	CONSTRAINT "task_nudge_slot_kind" CHECK("__new_task_nudge_slots"."kind" IN ('pre_due','custom','checkin','digest','followup','announce','review','clarify','evaluate','update')),
	CONSTRAINT "task_nudge_slot_state" CHECK("__new_task_nudge_slots"."state" IN ('pending','paused','claimed','sent','failed','superseded','planned'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_task_nudge_slots`("guild_id", "slot_id", "task_id", "team_id", "kind", "due_at", "state", "destination_id", "message_id", "payload", "last_error", "updated_at") SELECT "guild_id", "slot_id", "task_id", "team_id", "kind", "due_at", "state", "destination_id", "message_id", "payload", "last_error", "updated_at" FROM `task_nudge_slots`;--> statement-breakpoint
DROP TABLE `task_nudge_slots`;--> statement-breakpoint
ALTER TABLE `__new_task_nudge_slots` RENAME TO `task_nudge_slots`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `task_nudge_due` ON `task_nudge_slots` (`guild_id`,`state`,`due_at`);--> statement-breakpoint
CREATE INDEX `task_nudge_message` ON `task_nudge_slots` (`guild_id`,`message_id`);--> statement-breakpoint
ALTER TABLE `task_message_anchors` ADD `rendered_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `task_message_anchors` ADD `rendered_at` integer DEFAULT 0 NOT NULL;