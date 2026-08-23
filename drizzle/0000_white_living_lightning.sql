CREATE TABLE `account_guild_access` (
	`guild_id` text NOT NULL,
	`account_id` text NOT NULL,
	PRIMARY KEY(`guild_id`, `account_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `dashboard_accounts`(`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "account_guild_access_guild_id_snowflake" CHECK(("account_guild_access"."guild_id" NOT GLOB '*[^0-9]*' AND length("account_guild_access"."guild_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`audit_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`at` integer NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`actor_unix_user_claimed` text,
	`via` text,
	`action` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text,
	`batch_id` text,
	`before` text,
	`after` text,
	`dry_run` integer DEFAULT 0 NOT NULL,
	`inferred` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "audit_events_guild_id_snowflake" CHECK(("audit_events"."guild_id" NOT GLOB '*[^0-9]*' AND length("audit_events"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "audit_events_actor_type" CHECK("audit_events"."actor_type" IN ('member','owner','operator_cli','dashboard','system','doctor')),
	CONSTRAINT "audit_events_via" CHECK("audit_events"."via" IS NULL OR "audit_events"."via" IN ('ssh','http','gateway')),
	CONSTRAINT "audit_events_dry_run_bool" CHECK("audit_events"."dry_run" IN (0,1)),
	CONSTRAINT "audit_events_inferred_bool" CHECK("audit_events"."inferred" IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE INDEX `audit_tail` ON `audit_events` (`guild_id`,"at" desc);--> statement-breakpoint
CREATE TABLE `bootstrap_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
) STRICT;
--> statement-breakpoint
CREATE TABLE `capability_grants` (
	`guild_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`capability` text NOT NULL,
	`granted_at` integer NOT NULL,
	`granted_by` text NOT NULL,
	PRIMARY KEY(`guild_id`, `principal_type`, `principal_id`, `capability`),
	FOREIGN KEY (`guild_id`,`principal_type`,`principal_id`) REFERENCES `principals`(`guild_id`,`principal_type`,`principal_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "capability_grants_guild_id_snowflake" CHECK(("capability_grants"."guild_id" NOT GLOB '*[^0-9]*' AND length("capability_grants"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "capability_grants_principal_id_snowflake" CHECK(("capability_grants"."principal_id" NOT GLOB '*[^0-9]*' AND length("capability_grants"."principal_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `dashboard_accounts` (
	`account_id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`totp_secret_enc` text,
	`totp_enrolled` integer DEFAULT 0 NOT NULL,
	`is_owner` integer DEFAULT 0 NOT NULL,
	`disabled` integer DEFAULT 0 NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "dashboard_accounts_totp_enrolled_bool" CHECK("dashboard_accounts"."totp_enrolled" IN (0,1)),
	CONSTRAINT "dashboard_accounts_is_owner_bool" CHECK("dashboard_accounts"."is_owner" IN (0,1)),
	CONSTRAINT "dashboard_accounts_disabled_bool" CHECK("dashboard_accounts"."disabled" IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `dashboard_accounts_username` ON `dashboard_accounts` (`username`);--> statement-breakpoint
CREATE TABLE `dashboard_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`reauth_at` integer,
	`ip` text,
	FOREIGN KEY (`account_id`) REFERENCES `dashboard_accounts`(`account_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "dashboard_sessions_guild_id_snowflake" CHECK(("dashboard_sessions"."guild_id" NOT GLOB '*[^0-9]*' AND length("dashboard_sessions"."guild_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE INDEX `dashboard_sessions_by_account` ON `dashboard_sessions` (`guild_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `effect_batches` (
	`guild_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`source` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`undone_at` integer,
	PRIMARY KEY(`guild_id`, `batch_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "effect_batches_guild_id_snowflake" CHECK(("effect_batches"."guild_id" NOT GLOB '*[^0-9]*' AND length("effect_batches"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "effect_batches_source" CHECK("effect_batches"."source" IN ('interaction','reaction','adoption','reconcile','cli','dashboard'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `event_dedupe` (
	`guild_id` text NOT NULL,
	`event_kind` text NOT NULL,
	`fingerprint` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `event_kind`, `fingerprint`),
	CONSTRAINT "event_dedupe_guild_id_snowflake" CHECK(("event_dedupe"."guild_id" NOT GLOB '*[^0-9]*' AND length("event_dedupe"."guild_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE INDEX `event_dedupe_sweep` ON `event_dedupe` (`first_seen_at`);--> statement-breakpoint
CREATE TABLE `gateway_gaps` (
	`gap_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`disconnected_at` integer NOT NULL,
	`reconnected_at` integer NOT NULL,
	`resumed` integer NOT NULL,
	`reconciled_at` integer,
	CONSTRAINT "gateway_gaps_guild_id_snowflake" CHECK(("gateway_gaps"."guild_id" NOT GLOB '*[^0-9]*' AND length("gateway_gaps"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "gateway_gaps_resumed_bool" CHECK("gateway_gaps"."resumed" IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE INDEX `gateway_gaps_unreconciled` ON `gateway_gaps` (`guild_id`,`reconciled_at`);--> statement-breakpoint
CREATE TABLE `guilds` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`killswitch` integer DEFAULT 0 NOT NULL,
	`dry_run` integer DEFAULT 1 NOT NULL,
	`role_rate_per_min` integer DEFAULT 20 NOT NULL,
	`reconcile_budget` integer DEFAULT 25 NOT NULL,
	`breaker_threshold` integer DEFAULT 5 NOT NULL,
	`breaker_state` text DEFAULT 'closed' NOT NULL,
	`breaker_tripped_at` integer,
	`breaker_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "guilds_guild_id_snowflake" CHECK(("guilds"."guild_id" NOT GLOB '*[^0-9]*' AND length("guilds"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "guilds_breaker_state" CHECK("guilds"."breaker_state" IN ('closed','open')),
	CONSTRAINT "guilds_enabled_bool" CHECK("guilds"."enabled" IN (0,1)),
	CONSTRAINT "guilds_killswitch_bool" CHECK("guilds"."killswitch" IN (0,1)),
	CONSTRAINT "guilds_dry_run_bool" CHECK("guilds"."dry_run" IN (0,1)),
	CONSTRAINT "guilds_positive_limits" CHECK("guilds"."role_rate_per_min" > 0 AND "guilds"."reconcile_budget" > 0 AND "guilds"."breaker_threshold" > 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `jobs` (
	`job_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`run_after` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`cursor` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "jobs_guild_id_snowflake" CHECK(("jobs"."guild_id" NOT GLOB '*[^0-9]*' AND length("jobs"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "jobs_state" CHECK("jobs"."state" IN ('queued','running','done','failed','cancelled')),
	CONSTRAINT "jobs_attempts_sane" CHECK("jobs"."attempts" >= 0 AND "jobs"."max_attempts" > 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe` ON `jobs` (`guild_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `jobs_claim` ON `jobs` (`state`,`run_after`) WHERE "jobs"."state" = 'queued';--> statement-breakpoint
CREATE TABLE `log_excluded_channels` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "log_excluded_channels_guild_id_snowflake" CHECK(("log_excluded_channels"."guild_id" NOT GLOB '*[^0-9]*' AND length("log_excluded_channels"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "log_excluded_channels_channel_id_snowflake" CHECK(("log_excluded_channels"."channel_id" NOT GLOB '*[^0-9]*' AND length("log_excluded_channels"."channel_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `log_routes` (
	`guild_id` text NOT NULL,
	`event_kind` text NOT NULL,
	`channel_id` text NOT NULL,
	`include_content` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`guild_id`, `event_kind`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "log_routes_guild_id_snowflake" CHECK(("log_routes"."guild_id" NOT GLOB '*[^0-9]*' AND length("log_routes"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "log_routes_channel_id_snowflake" CHECK(("log_routes"."channel_id" NOT GLOB '*[^0-9]*' AND length("log_routes"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "log_routes_include_content_bool" CHECK("log_routes"."include_content" IN (0,1)),
	CONSTRAINT "log_routes_enabled_bool" CHECK("log_routes"."enabled" IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `managed_role_assignments` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`panel_id` text NOT NULL,
	`granted_at` integer NOT NULL,
	`granted_by_effect` text NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`, `role_id`),
	FOREIGN KEY (`guild_id`,`panel_id`) REFERENCES `panels`(`guild_id`,`panel_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guild_id`,`role_id`) REFERENCES `managed_roles`(`guild_id`,`role_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "managed_role_assignments_guild_id_snowflake" CHECK(("managed_role_assignments"."guild_id" NOT GLOB '*[^0-9]*' AND length("managed_role_assignments"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "managed_role_assignments_user_id_snowflake" CHECK(("managed_role_assignments"."user_id" NOT GLOB '*[^0-9]*' AND length("managed_role_assignments"."user_id") BETWEEN 17 AND 20)),
	CONSTRAINT "managed_role_assignments_role_id_snowflake" CHECK(("managed_role_assignments"."role_id" NOT GLOB '*[^0-9]*' AND length("managed_role_assignments"."role_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `managed_roles` (
	`guild_id` text NOT NULL,
	`role_id` text NOT NULL,
	`assignable` integer DEFAULT 1 NOT NULL,
	`unassignable_reason` text,
	`last_checked_at` integer,
	PRIMARY KEY(`guild_id`, `role_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "managed_roles_guild_id_snowflake" CHECK(("managed_roles"."guild_id" NOT GLOB '*[^0-9]*' AND length("managed_roles"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "managed_roles_role_id_snowflake" CHECK(("managed_roles"."role_id" NOT GLOB '*[^0-9]*' AND length("managed_roles"."role_id") BETWEEN 17 AND 20)),
	CONSTRAINT "managed_roles_assignable_bool" CHECK("managed_roles"."assignable" IN (0,1)),
	CONSTRAINT "managed_roles_unassignable_reason" CHECK("managed_roles"."unassignable_reason" IS NULL OR "managed_roles"."unassignable_reason" IN ('above_bot','managed','deleted'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `panel_blocked_roles` (
	`guild_id` text NOT NULL,
	`panel_id` text NOT NULL,
	`role_id` text NOT NULL,
	PRIMARY KEY(`guild_id`, `panel_id`, `role_id`),
	FOREIGN KEY (`guild_id`,`panel_id`) REFERENCES `panels`(`guild_id`,`panel_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "panel_blocked_roles_guild_id_snowflake" CHECK(("panel_blocked_roles"."guild_id" NOT GLOB '*[^0-9]*' AND length("panel_blocked_roles"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "panel_blocked_roles_role_id_snowflake" CHECK(("panel_blocked_roles"."role_id" NOT GLOB '*[^0-9]*' AND length("panel_blocked_roles"."role_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `panel_options` (
	`guild_id` text NOT NULL,
	`panel_id` text NOT NULL,
	`option_id` text NOT NULL,
	`role_id` text NOT NULL,
	`emoji_key` text,
	`label` text,
	`position` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `panel_id`, `option_id`),
	FOREIGN KEY (`guild_id`,`panel_id`) REFERENCES `panels`(`guild_id`,`panel_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guild_id`,`role_id`) REFERENCES `managed_roles`(`guild_id`,`role_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "panel_options_guild_id_snowflake" CHECK(("panel_options"."guild_id" NOT GLOB '*[^0-9]*' AND length("panel_options"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "panel_options_role_id_snowflake" CHECK(("panel_options"."role_id" NOT GLOB '*[^0-9]*' AND length("panel_options"."role_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `panel_options_role_once` ON `panel_options` (`guild_id`,`panel_id`,`role_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `panel_options_emoji_once` ON `panel_options` (`guild_id`,`panel_id`,`emoji_key`);--> statement-breakpoint
CREATE TABLE `panels` (
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
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `panel_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "panels_guild_id_snowflake" CHECK(("panels"."guild_id" NOT GLOB '*[^0-9]*' AND length("panels"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "panels_channel_id_snowflake" CHECK(("panels"."channel_id" NOT GLOB '*[^0-9]*' AND length("panels"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "panels_message_id_snowflake" CHECK(("panels"."message_id" IS NULL OR ("panels"."message_id" NOT GLOB '*[^0-9]*' AND length("panels"."message_id") BETWEEN 17 AND 20))),
	CONSTRAINT "panels_required_role_id_snowflake" CHECK(("panels"."required_role_id" IS NULL OR ("panels"."required_role_id" NOT GLOB '*[^0-9]*' AND length("panels"."required_role_id") BETWEEN 17 AND 20))),
	CONSTRAINT "panels_kind" CHECK("panels"."kind" IN ('adopted','managed')),
	CONSTRAINT "panels_behaviour" CHECK("panels"."behaviour" IN ('toggle','add_only','remove_only','single_choice')),
	CONSTRAINT "panels_component" CHECK("panels"."component" IN ('reaction','button','select')),
	CONSTRAINT "panels_status" CHECK("panels"."status" IN ('enabled','disabled_by_doctor','disabled_by_owner')),
	CONSTRAINT "panels_adoption_pass_state" CHECK("panels"."adoption_pass_state" IN ('pending','running','done','refused')),
	CONSTRAINT "panels_adopted_is_reaction" CHECK("panels"."kind" <> 'adopted' OR "panels"."component" = 'reaction'),
	CONSTRAINT "panels_single_choice_is_managed" CHECK("panels"."behaviour" <> 'single_choice' OR "panels"."kind" = 'managed'),
	CONSTRAINT "panels_max_roles_positive" CHECK("panels"."max_roles" IS NULL OR "panels"."max_roles" > 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `panels_message_once` ON `panels` (`guild_id`,`channel_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `principals` (
	`guild_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`protected` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `principal_type`, `principal_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "principals_guild_id_snowflake" CHECK(("principals"."guild_id" NOT GLOB '*[^0-9]*' AND length("principals"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "principals_principal_id_snowflake" CHECK(("principals"."principal_id" NOT GLOB '*[^0-9]*' AND length("principals"."principal_id") BETWEEN 17 AND 20)),
	CONSTRAINT "principals_principal_type" CHECK("principals"."principal_type" IN ('user','role')),
	CONSTRAINT "principals_protected_bool" CHECK("principals"."protected" IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `role_effects` (
	`guild_id` text NOT NULL,
	`effect_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`action` text NOT NULL,
	`state` text DEFAULT 'planned' NOT NULL,
	`had_role_before` integer NOT NULL,
	`panel_id` text,
	`attempted_at` integer,
	`completed_at` integer,
	`error_code` text,
	PRIMARY KEY(`guild_id`, `effect_id`),
	FOREIGN KEY (`guild_id`,`batch_id`) REFERENCES `effect_batches`(`guild_id`,`batch_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guild_id`,`role_id`) REFERENCES `managed_roles`(`guild_id`,`role_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "role_effects_guild_id_snowflake" CHECK(("role_effects"."guild_id" NOT GLOB '*[^0-9]*' AND length("role_effects"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "role_effects_user_id_snowflake" CHECK(("role_effects"."user_id" NOT GLOB '*[^0-9]*' AND length("role_effects"."user_id") BETWEEN 17 AND 20)),
	CONSTRAINT "role_effects_role_id_snowflake" CHECK(("role_effects"."role_id" NOT GLOB '*[^0-9]*' AND length("role_effects"."role_id") BETWEEN 17 AND 20)),
	CONSTRAINT "role_effects_action" CHECK("role_effects"."action" IN ('grant','revoke')),
	CONSTRAINT "role_effects_state" CHECK("role_effects"."state" IN ('planned','applied','skipped','failed','dry_run')),
	CONSTRAINT "role_effects_had_role_before_bool" CHECK("role_effects"."had_role_before" IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `role_effects_dedupe` ON `role_effects` (`guild_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `role_effects_recent` ON `role_effects` (`guild_id`,`user_id`,`role_id`,`completed_at`);