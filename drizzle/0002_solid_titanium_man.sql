PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_panels` (
	`guild_id` text NOT NULL,
	`panel_id` text NOT NULL,
	`kind` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text,
	`behaviour` text NOT NULL,
	`component` text NOT NULL,
	`max_roles` integer,
	`required_role_id` text,
	`status` text DEFAULT 'enabled' NOT NULL,
	`disabled_reason` text,
	`adopted_at` integer,
	`adoption_pass_state` text DEFAULT 'pending' NOT NULL,
	`adoption_blocked_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `panel_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "panels_guild_id_snowflake" CHECK(("__new_panels"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_panels"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "panels_channel_id_snowflake" CHECK(("__new_panels"."channel_id" NOT GLOB '*[^0-9]*' AND length("__new_panels"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "panels_message_id_snowflake" CHECK(("__new_panels"."message_id" IS NULL OR ("__new_panels"."message_id" NOT GLOB '*[^0-9]*' AND length("__new_panels"."message_id") BETWEEN 17 AND 20))),
	CONSTRAINT "panels_required_role_id_snowflake" CHECK(("__new_panels"."required_role_id" IS NULL OR ("__new_panels"."required_role_id" NOT GLOB '*[^0-9]*' AND length("__new_panels"."required_role_id") BETWEEN 17 AND 20))),
	CONSTRAINT "panels_kind" CHECK("__new_panels"."kind" IN ('adopted','managed')),
	CONSTRAINT "panels_behaviour" CHECK("__new_panels"."behaviour" IN ('toggle','add_only','remove_only','single_choice')),
	CONSTRAINT "panels_component" CHECK("__new_panels"."component" IN ('reaction','button','select')),
	CONSTRAINT "panels_status" CHECK("__new_panels"."status" IN ('enabled','disabled_by_doctor','disabled_by_owner')),
	CONSTRAINT "panels_adoption_pass_state" CHECK("__new_panels"."adoption_pass_state" IN ('pending','running','done','refused')),
	CONSTRAINT "panels_adoption_blocked_count_nonnegative" CHECK("__new_panels"."adoption_blocked_count" >= 0),
	CONSTRAINT "panels_adopted_is_reaction" CHECK("__new_panels"."kind" <> 'adopted' OR "__new_panels"."component" = 'reaction'),
	CONSTRAINT "panels_single_choice_is_managed" CHECK("__new_panels"."behaviour" <> 'single_choice' OR "__new_panels"."kind" = 'managed'),
	CONSTRAINT "panels_max_roles_positive" CHECK("__new_panels"."max_roles" IS NULL OR "__new_panels"."max_roles" > 0)
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_panels`("guild_id", "panel_id", "kind", "channel_id", "message_id", "behaviour", "component", "max_roles", "required_role_id", "status", "disabled_reason", "adopted_at", "adoption_pass_state", "created_at", "updated_at") SELECT "guild_id", "panel_id", "kind", "channel_id", "message_id", "behaviour", "component", "max_roles", "required_role_id", "status", "disabled_reason", "adopted_at", "adoption_pass_state", "created_at", "updated_at" FROM `panels`;--> statement-breakpoint
DROP TABLE `panels`;--> statement-breakpoint
ALTER TABLE `__new_panels` RENAME TO `panels`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `panels_message_once` ON `panels` (`guild_id`,`channel_id`,`message_id`);