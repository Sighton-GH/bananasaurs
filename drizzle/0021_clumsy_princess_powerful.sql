CREATE TABLE `oauth_authorization_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`account_id` text NOT NULL,
	`scopes` text NOT NULL,
	`code_challenge` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
) STRICT;
--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_account_id` text,
	`registration_source` text NOT NULL,
	CONSTRAINT "oauth_clients_registration_source" CHECK("oauth_clients"."registration_source" IN ('dynamic','cli'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `oauth_pending_authorizations` (
	`request_id` text PRIMARY KEY NOT NULL,
	`nonce_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`scopes` text NOT NULL,
	`code_challenge` text NOT NULL,
	`state` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
) STRICT;
--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`token_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`client_id` text NOT NULL,
	`account_id` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`last_used_at` integer,
	`parent_token_id` text,
	`issued_from_code_hash` text NOT NULL,
	CONSTRAINT "oauth_tokens_kind" CHECK("oauth_tokens"."kind" IN ('access','refresh'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_hash` ON `oauth_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `oauth_tokens_by_account` ON `oauth_tokens` (`account_id`);--> statement-breakpoint
CREATE INDEX `oauth_tokens_by_client` ON `oauth_tokens` (`client_id`);