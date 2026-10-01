CREATE TABLE `club_tasks` (
	`guild_id` text NOT NULL,
	`task_id` text NOT NULL,
	`team_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'not_started' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`assignment_kind` text NOT NULL,
	`assignee_id` text,
	`due_at` integer NOT NULL,
	`timezone` text NOT NULL,
	`destination_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`archived_at` integer,
	PRIMARY KEY(`guild_id`, `task_id`),
	FOREIGN KEY (`guild_id`,`team_id`) REFERENCES `task_teams`(`guild_id`,`team_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "club_tasks_guild_snowflake" CHECK(("club_tasks"."guild_id" NOT GLOB '*[^0-9]*' AND length("club_tasks"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "club_tasks_destination_snowflake" CHECK(("club_tasks"."destination_id" NOT GLOB '*[^0-9]*' AND length("club_tasks"."destination_id") BETWEEN 17 AND 20)),
	CONSTRAINT "club_tasks_assignee_snowflake" CHECK(("club_tasks"."assignee_id" IS NULL OR ("club_tasks"."assignee_id" NOT GLOB '*[^0-9]*' AND length("club_tasks"."assignee_id") BETWEEN 17 AND 20))),
	CONSTRAINT "club_tasks_status" CHECK("club_tasks"."status" IN ('not_started','in_progress','awaiting_approval','done')),
	CONSTRAINT "club_tasks_priority" CHECK("club_tasks"."priority" IN ('normal','urgent')),
	CONSTRAINT "club_tasks_assignment" CHECK("club_tasks"."assignment_kind" IN ('team','individual')),
	CONSTRAINT "club_tasks_assignment_id" CHECK(("club_tasks"."assignment_kind" = 'team' AND "club_tasks"."assignee_id" IS NULL) OR ("club_tasks"."assignment_kind" = 'individual' AND "club_tasks"."assignee_id" IS NOT NULL)),
	CONSTRAINT "club_tasks_version_positive" CHECK("club_tasks"."version" > 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `task_assignees` (
	`guild_id` text NOT NULL,
	`task_id` text NOT NULL,
	`discord_user_id` text NOT NULL,
	PRIMARY KEY(`guild_id`, `task_id`, `discord_user_id`),
	FOREIGN KEY (`guild_id`,`task_id`) REFERENCES `club_tasks`(`guild_id`,`task_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_assignees_guild_snowflake" CHECK(("task_assignees"."guild_id" NOT GLOB '*[^0-9]*' AND length("task_assignees"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_assignees_user_snowflake" CHECK(("task_assignees"."discord_user_id" NOT GLOB '*[^0-9]*' AND length("task_assignees"."discord_user_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `task_children` (
	`guild_id` text NOT NULL,
	`task_id` text NOT NULL,
	`child_id` text NOT NULL,
	`title` text NOT NULL,
	`due_at` integer NOT NULL,
	`status` text DEFAULT 'not_started' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	PRIMARY KEY(`guild_id`, `task_id`, `child_id`),
	FOREIGN KEY (`guild_id`,`task_id`) REFERENCES `club_tasks`(`guild_id`,`task_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_children_guild_snowflake" CHECK(("task_children"."guild_id" NOT GLOB '*[^0-9]*' AND length("task_children"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_children_status" CHECK("task_children"."status" IN ('not_started','in_progress','done'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `task_guild_roles` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`president_role_id` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_guild_roles_guild_snowflake" CHECK(("task_guild_roles"."guild_id" NOT GLOB '*[^0-9]*' AND length("task_guild_roles"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_guild_roles_president_snowflake" CHECK(("task_guild_roles"."president_role_id" NOT GLOB '*[^0-9]*' AND length("task_guild_roles"."president_role_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `task_message_anchors` (
	`guild_id` text NOT NULL,
	`task_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `task_id`),
	FOREIGN KEY (`guild_id`,`task_id`) REFERENCES `club_tasks`(`guild_id`,`task_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_anchor_guild_snowflake" CHECK(("task_message_anchors"."guild_id" NOT GLOB '*[^0-9]*' AND length("task_message_anchors"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_anchor_channel_snowflake" CHECK(("task_message_anchors"."channel_id" NOT GLOB '*[^0-9]*' AND length("task_message_anchors"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_anchor_message_snowflake" CHECK(("task_message_anchors"."message_id" NOT GLOB '*[^0-9]*' AND length("task_message_anchors"."message_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `task_anchor_message_once` ON `task_message_anchors` (`guild_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `task_nudge_deliveries` (
	`guild_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`outcome` text NOT NULL,
	`destination_id` text,
	`message_id` text,
	`attempted_at` integer NOT NULL,
	`detail` text,
	PRIMARY KEY(`guild_id`, `slot_id`),
	FOREIGN KEY (`guild_id`,`slot_id`) REFERENCES `task_nudge_slots`(`guild_id`,`slot_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_nudge_delivery_guild" CHECK(("task_nudge_deliveries"."guild_id" NOT GLOB '*[^0-9]*' AND length("task_nudge_deliveries"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_nudge_delivery_destination" CHECK(("task_nudge_deliveries"."destination_id" IS NULL OR ("task_nudge_deliveries"."destination_id" NOT GLOB '*[^0-9]*' AND length("task_nudge_deliveries"."destination_id") BETWEEN 17 AND 20))),
	CONSTRAINT "task_nudge_delivery_message" CHECK(("task_nudge_deliveries"."message_id" IS NULL OR ("task_nudge_deliveries"."message_id" NOT GLOB '*[^0-9]*' AND length("task_nudge_deliveries"."message_id") BETWEEN 17 AND 20)))
) STRICT;
--> statement-breakpoint
CREATE TABLE `task_nudge_slot_tasks` (
	`guild_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`task_id` text NOT NULL,
	PRIMARY KEY(`guild_id`, `slot_id`, `task_id`),
	FOREIGN KEY (`guild_id`,`slot_id`) REFERENCES `task_nudge_slots`(`guild_id`,`slot_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guild_id`,`task_id`) REFERENCES `club_tasks`(`guild_id`,`task_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_nudge_slot_task_guild" CHECK(("task_nudge_slot_tasks"."guild_id" NOT GLOB '*[^0-9]*' AND length("task_nudge_slot_tasks"."guild_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `task_nudge_slots` (
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
	CONSTRAINT "task_nudge_slot_guild" CHECK(("task_nudge_slots"."guild_id" NOT GLOB '*[^0-9]*' AND length("task_nudge_slots"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_nudge_slot_destination" CHECK(("task_nudge_slots"."destination_id" IS NULL OR ("task_nudge_slots"."destination_id" NOT GLOB '*[^0-9]*' AND length("task_nudge_slots"."destination_id") BETWEEN 17 AND 20))),
	CONSTRAINT "task_nudge_slot_message" CHECK(("task_nudge_slots"."message_id" IS NULL OR ("task_nudge_slots"."message_id" NOT GLOB '*[^0-9]*' AND length("task_nudge_slots"."message_id") BETWEEN 17 AND 20))),
	CONSTRAINT "task_nudge_slot_kind" CHECK("task_nudge_slots"."kind" IN ('pre_due','custom','checkin','digest','followup','announce','review','clarify','evaluate')),
	CONSTRAINT "task_nudge_slot_state" CHECK("task_nudge_slots"."state" IN ('pending','paused','claimed','sent','failed','superseded','planned'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `task_nudge_due` ON `task_nudge_slots` (`guild_id`,`state`,`due_at`);--> statement-breakpoint
CREATE INDEX `task_nudge_message` ON `task_nudge_slots` (`guild_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `task_quiet_hours` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`start_minute` integer NOT NULL,
	`end_minute` integer NOT NULL,
	`timezone` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_quiet_guild_snowflake" CHECK(("task_quiet_hours"."guild_id" NOT GLOB '*[^0-9]*' AND length("task_quiet_hours"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_quiet_start" CHECK("task_quiet_hours"."start_minute" BETWEEN 0 AND 1439),
	CONSTRAINT "task_quiet_end" CHECK("task_quiet_hours"."end_minute" BETWEEN 0 AND 1439),
	CONSTRAINT "task_quiet_distinct" CHECK("task_quiet_hours"."start_minute" <> "task_quiet_hours"."end_minute")
) STRICT;
--> statement-breakpoint
CREATE TABLE `task_reply_choices` (
	`guild_id` text NOT NULL,
	`message_id` text NOT NULL,
	`author_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `message_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_reply_choice_guild" CHECK(("task_reply_choices"."guild_id" NOT GLOB '*[^0-9]*' AND length("task_reply_choices"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_reply_choice_message" CHECK(("task_reply_choices"."message_id" NOT GLOB '*[^0-9]*' AND length("task_reply_choices"."message_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_reply_choice_author" CHECK(("task_reply_choices"."author_id" NOT GLOB '*[^0-9]*' AND length("task_reply_choices"."author_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_reply_choice_channel" CHECK(("task_reply_choices"."channel_id" NOT GLOB '*[^0-9]*' AND length("task_reply_choices"."channel_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE INDEX `task_reply_choice_created` ON `task_reply_choices` (`guild_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `task_reports` (
	`guild_id` text NOT NULL,
	`task_id` text NOT NULL,
	`report_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `task_id`, `report_id`),
	FOREIGN KEY (`guild_id`,`task_id`) REFERENCES `club_tasks`(`guild_id`,`task_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_reports_guild_snowflake" CHECK(("task_reports"."guild_id" NOT GLOB '*[^0-9]*' AND length("task_reports"."guild_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `task_team_members` (
	`guild_id` text NOT NULL,
	`team_id` text NOT NULL,
	`discord_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `team_id`, `discord_user_id`),
	FOREIGN KEY (`guild_id`,`team_id`) REFERENCES `task_teams`(`guild_id`,`team_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_member_guild_snowflake" CHECK(("task_team_members"."guild_id" NOT GLOB '*[^0-9]*' AND length("task_team_members"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_member_user_snowflake" CHECK(("task_team_members"."discord_user_id" NOT GLOB '*[^0-9]*' AND length("task_team_members"."discord_user_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_member_kind" CHECK("task_team_members"."kind" IN ('member','lead'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `task_teams` (
	`guild_id` text NOT NULL,
	`team_id` text NOT NULL,
	`name` text NOT NULL,
	`category_id` text NOT NULL,
	`announcement_channel_id` text,
	`lead_role_id` text,
	`member_role_id` text,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `team_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_teams_kind" CHECK("task_teams"."kind" IN ('subteam','exec')),
	CONSTRAINT "task_teams_guild_snowflake" CHECK(("task_teams"."guild_id" NOT GLOB '*[^0-9]*' AND length("task_teams"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_teams_category_snowflake" CHECK(("task_teams"."category_id" NOT GLOB '*[^0-9]*' AND length("task_teams"."category_id") BETWEEN 17 AND 20)),
	CONSTRAINT "task_teams_announcement_snowflake" CHECK(("task_teams"."announcement_channel_id" IS NULL OR ("task_teams"."announcement_channel_id" NOT GLOB '*[^0-9]*' AND length("task_teams"."announcement_channel_id") BETWEEN 17 AND 20))),
	CONSTRAINT "task_teams_lead_role_snowflake" CHECK(("task_teams"."lead_role_id" IS NULL OR ("task_teams"."lead_role_id" NOT GLOB '*[^0-9]*' AND length("task_teams"."lead_role_id") BETWEEN 17 AND 20))),
	CONSTRAINT "task_teams_member_role_snowflake" CHECK(("task_teams"."member_role_id" IS NULL OR ("task_teams"."member_role_id" NOT GLOB '*[^0-9]*' AND length("task_teams"."member_role_id") BETWEEN 17 AND 20)))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `task_teams_category_once` ON `task_teams` (`guild_id`,`category_id`);