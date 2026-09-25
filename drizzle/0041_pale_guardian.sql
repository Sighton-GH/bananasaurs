CREATE TABLE `resource_chunks` (
	`guild_id` text NOT NULL,
	`chunk_id` text NOT NULL,
	`doc_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`heading_path` text NOT NULL,
	`line_start` integer NOT NULL,
	`line_end` integer NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`guild_id`, `chunk_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guild_id`,`doc_id`) REFERENCES `resource_documents`(`guild_id`,`doc_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "resource_chunks_guild_id_snowflake" CHECK(("resource_chunks"."guild_id" NOT GLOB '*[^0-9]*' AND length("resource_chunks"."guild_id") BETWEEN 17 AND 20))
) STRICT;
--> statement-breakpoint
CREATE INDEX `resource_chunks_doc` ON `resource_chunks` (`guild_id`,`doc_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `resource_chunks_resource` ON `resource_chunks` (`guild_id`,`resource_id`);--> statement-breakpoint
CREATE TABLE `resource_documents` (
	`guild_id` text NOT NULL,
	`doc_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`url` text NOT NULL,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`etag` text,
	`last_modified` text,
	`content_hash` text DEFAULT '' NOT NULL,
	`fetched_at` integer NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`error` text,
	PRIMARY KEY(`guild_id`, `doc_id`),
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`guild_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guild_id`,`resource_id`) REFERENCES `assistant_resources`(`guild_id`,`resource_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "resource_documents_guild_id_snowflake" CHECK(("resource_documents"."guild_id" NOT GLOB '*[^0-9]*' AND length("resource_documents"."guild_id") BETWEEN 17 AND 20)),
	CONSTRAINT "resource_documents_status" CHECK("resource_documents"."status" IN ('ok','error'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `resource_documents_resource` ON `resource_documents` (`guild_id`,`resource_id`);