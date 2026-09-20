DROP TABLE "agent_tasks" CASCADE;--> statement-breakpoint
DROP TABLE "device_tokens" CASCADE;--> statement-breakpoint
DROP TABLE "magic_links" CASCADE;--> statement-breakpoint
DROP TABLE "oauth_clients" CASCADE;--> statement-breakpoint
DROP TABLE "oauth_codes" CASCADE;--> statement-breakpoint
DROP TABLE "oauth_grants" CASCADE;--> statement-breakpoint
DROP TABLE "sessions" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "quota_screens_month";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "quota_tokens_month";