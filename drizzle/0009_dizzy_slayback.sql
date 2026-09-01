PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_mod_case_events` (
	`guild_id` text NOT NULL,
	`event_id` text NOT NULL,
	`case_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`member_id` text NOT NULL,
	`at` integer NOT NULL,
	`matched_category` text NOT NULL,
	`matched_snippet` text NOT NULL,
	`action_taken` text NOT NULL,
	`escalation_action` text,
	`refusal_reason` text,
	`actor_id` text,
	PRIMARY KEY(`guild_id`, `event_id`),
	FOREIGN KEY (`guild_id`,`case_id`) REFERENCES `mod_cases`(`guild_id`,`case_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mod_case_events_guild_id_snowflake" CHECK(("__new_mod_case_events"."guild_id" NOT GLOB '*[^0-9]*' AND length("__new_mod_case_events"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mod_case_events_member_id_snowflake" CHECK(("__new_mod_case_events"."member_id" NOT GLOB '*[^0-9]*' AND length("__new_mod_case_events"."member_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mod_case_events_action_taken" CHECK("__new_mod_case_events"."action_taken" IN (
        'deleted','deleted_and_escalated','escalation_refused','escalation_failed',
        'escalation_dry_run','escalation_skipped','would_delete','delete_failed',
        'delete_blocked_killswitch','delete_blocked_breaker','delete_blocked_dry_run',
        'delete_blocked_guild_unknown',
        'warned','note','evidence_added','purged','purge_refused','purge_failed',
        'manual_applied',
        'native_blocked','native_alerted','native_timeout','native_blocked_interaction')),
	CONSTRAINT "mod_case_events_escalation_action" CHECK("__new_mod_case_events"."escalation_action" IS NULL OR "__new_mod_case_events"."escalation_action" IN ('timeout','kick','ban','unban')),
	CONSTRAINT "mod_case_events_refusal_reason" CHECK("__new_mod_case_events"."refusal_reason" IS NULL OR "__new_mod_case_events"."refusal_reason" IN
        ('unauthorized','guild-unknown','killswitch','breaker-open','rate-cap','discord-owner','role-above-bot')),
	CONSTRAINT "mod_case_events_actor_id_snowflake" CHECK(("__new_mod_case_events"."actor_id" IS NULL OR ("__new_mod_case_events"."actor_id" NOT GLOB '*[^0-9]*' AND length("__new_mod_case_events"."actor_id") BETWEEN 17 AND 20)))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_mod_case_events`("guild_id", "event_id", "case_id", "rule_id", "member_id", "at", "matched_category", "matched_snippet", "action_taken", "escalation_action", "refusal_reason", "actor_id") SELECT "guild_id", "event_id", "case_id", "rule_id", "member_id", "at", "matched_category", "matched_snippet", "action_taken", "escalation_action", "refusal_reason", "actor_id" FROM `mod_case_events`;--> statement-breakpoint
DROP TABLE `mod_case_events`;--> statement-breakpoint
ALTER TABLE `__new_mod_case_events` RENAME TO `mod_case_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;