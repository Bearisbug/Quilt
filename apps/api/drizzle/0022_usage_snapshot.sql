ALTER TABLE "usage_entries" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_entries" ADD COLUMN "project_name" text;--> statement-breakpoint
ALTER TABLE "usage_entries" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "usage_entries" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_entries" ADD COLUMN "channel_label" text;--> statement-breakpoint
-- 回填（ADR-036）：按 job_id 联现存的作业、项目与通道；作业已随项目删掉的旧记录留空
UPDATE "usage_entries" AS u SET
  "project_id" = j."project_id",
  "project_name" = p."name",
  "kind" = j."kind",
  "channel_id" = CASE WHEN j."input"->'runner'->>'kind' = 'channel' AND (j."input"->'runner'->>'channelId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (j."input"->'runner'->>'channelId')::uuid END,
  "channel_label" = c."label"
FROM "generation_jobs" AS j
JOIN "projects" AS p ON p."id" = j."project_id"
LEFT JOIN "channels" AS c ON c."id"::text = j."input"->'runner'->>'channelId'
WHERE u."job_id" = j."id";
