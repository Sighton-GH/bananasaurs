CREATE TABLE `mcp_bulk_previews` (
	`guild_id` text NOT NULL,
	`preview_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`action_kind` text NOT NULL,
	`role_id` text NOT NULL,
	`args_hash` text NOT NULL,
	`member_ids_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`job_id` integer,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mcp_bulk_previews_guild_id_snowflake" CHECK(("mcp_bulk_previews"."guild_id" NOT GLOB '*[^0-9]*' AND length("mcp_bulk_previews"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mcp_bulk_previews_role_id_snowflake" CHECK(("mcp_bulk_previews"."role_id" NOT GLOB '*[^0-9]*' AND length("mcp_bulk_previews"."role_id") BETWEEN 17 AND 20)),
	CONSTRAINT "mcp_bulk_previews_action_kind" CHECK("mcp_bulk_previews"."action_kind" IN ('add','remove')),
	CONSTRAINT "mcp_bulk_previews_expiry_sane" CHECK("mcp_bulk_previews"."expires_at" > "mcp_bulk_previews"."created_at")
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_bulk_previews_preview_once` ON `mcp_bulk_previews` (`guild_id`,`preview_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_bulk_previews_token_once` ON `mcp_bulk_previews` (`guild_id`,`token_hash`);