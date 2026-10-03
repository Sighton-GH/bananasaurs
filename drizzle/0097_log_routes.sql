CREATE TABLE `log_member_snapshots` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`username` text NOT NULL,
	`global_name` text,
	`nickname` text,
	`avatar_hash` text,
	`guild_avatar_hash` text,
	`role_ids` text DEFAULT '[]' NOT NULL,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "log_member_snapshots_guild_id_snowflake" CHECK(("log_member_snapshots"."guild_id" NOT GLOB '*[^0-9]*' AND length("log_member_snapshots"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "log_member_snapshots_user_id_snowflake" CHECK(("log_member_snapshots"."user_id" NOT GLOB '*[^0-9]*' AND length("log_member_snapshots"."user_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `log_route_events` (
	`guild_id` text NOT NULL,
	`route_id` text NOT NULL,
	`event_kind` text NOT NULL,
	PRIMARY KEY(`guild_id`, `route_id`, `event_kind`),
	FOREIGN KEY (`guild_id`,`route_id`) REFERENCES `log_routes`(`guild_id`,`route_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "log_route_events_guild_id_snowflake" CHECK(("log_route_events"."guild_id" NOT GLOB '*[^0-9]*' AND length("log_route_events"."guild_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `log_route_exclusions` (
	`guild_id` text NOT NULL,
	`route_id` text NOT NULL,
	`channel_id` text NOT NULL,
	PRIMARY KEY(`guild_id`, `route_id`, `channel_id`),
	FOREIGN KEY (`guild_id`,`route_id`) REFERENCES `log_routes`(`guild_id`,`route_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "log_route_exclusions_guild_id_snowflake" CHECK(("log_route_exclusions"."guild_id" NOT GLOB '*[^0-9]*' AND length("log_route_exclusions"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "log_route_exclusions_channel_id_snowflake" CHECK(("log_route_exclusions"."channel_id" NOT GLOB '*[^0-9]*' AND length("log_route_exclusions"."channel_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE TABLE `log_routes` (
	`guild_id` text NOT NULL,
	`route_id` text NOT NULL,
	`name` text NOT NULL,
	`channel_id` text NOT NULL,
	`include_content` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at_ms` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `route_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "log_routes_guild_id_snowflake" CHECK(("log_routes"."guild_id" NOT GLOB '*[^0-9]*' AND length("log_routes"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "log_routes_channel_id_snowflake" CHECK(("log_routes"."channel_id" NOT GLOB '*[^0-9]*' AND length("log_routes"."channel_id") BETWEEN 17 AND 20)),
	CONSTRAINT "log_routes_include_content_bool" CHECK("log_routes"."include_content" IN (0,1)),
	CONSTRAINT "log_routes_enabled_bool" CHECK("log_routes"."enabled" IN (0,1))
) STRICT;
