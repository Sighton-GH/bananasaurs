ALTER TABLE `assistant_reminders` ADD `mentions_json` text DEFAULT '{"userIds":[],"roleIds":[],"everyone":false,"here":false}' NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_reminders` ADD `recurrence_json` text;--> statement-breakpoint
ALTER TABLE `assistant_reminders` ADD `context` text;--> statement-breakpoint
ALTER TABLE `assistant_reminders` ADD `delivered_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_reminders` ADD `updated_at` integer;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assistant_skill_grants` (
	`guild_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`role_ids_json` text DEFAULT '[]' NOT NULL,
	`user_ids_json` text DEFAULT '[]' NOT NULL,
	`mode` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `skill_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assistant_skill_grants_guild_id_snowflake" CHECK(("__new_assistant_skill_grants"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_assistant_skill_grants"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "assistant_skill_grants_mode" CHECK("__new_assistant_skill_grants"."mode" IS NULL OR "__new_assistant_skill_grants"."mode" IN ('everyone','roles','owner'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_assistant_skill_grants`("guild_id", "skill_id", "role_ids_json", "user_ids_json", "mode", "updated_at") SELECT "guild_id", "skill_id", "role_ids_json", "user_ids_json", NULL, "updated_at" FROM `assistant_skill_grants`;--> statement-breakpoint
DROP TABLE `assistant_skill_grants`;--> statement-breakpoint
ALTER TABLE `__new_assistant_skill_grants` RENAME TO `assistant_skill_grants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
-- ADR 0086: one `reminders` skill replaces create-reminder and send-reminder.
UPDATE `assistant_behaviours` SET `skill_ids_json` = (
  SELECT json_group_array(DISTINCT CASE WHEN `value` IN ('create-reminder','send-reminder') THEN 'reminders' ELSE `value` END)
  FROM json_each(`assistant_behaviours`.`skill_ids_json`)
) WHERE `skill_ids_json` LIKE '%-reminder"%';
--> statement-breakpoint
UPDATE `assistant_skill_grants` SET `skill_id` = 'reminders' WHERE `skill_id` = 'create-reminder';
--> statement-breakpoint
DELETE FROM `assistant_skill_grants` WHERE `skill_id` = 'send-reminder';
