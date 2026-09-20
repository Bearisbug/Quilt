-- v0.32 本地单用户壳（ADR-016）：所有存量数据归到默认用户 local@quilt.local，其余用户行删除。
-- 全新安装（PGlite）时 users 为空，只会插入这一行。
INSERT INTO "users" ("email") VALUES ('local@quilt.local') ON CONFLICT ("email") DO NOTHING;--> statement-breakpoint
UPDATE "projects" SET "owner_id" = (SELECT "id" FROM "users" WHERE "email" = 'local@quilt.local') WHERE "owner_id" <> (SELECT "id" FROM "users" WHERE "email" = 'local@quilt.local');--> statement-breakpoint
UPDATE "generation_jobs" SET "created_by" = (SELECT "id" FROM "users" WHERE "email" = 'local@quilt.local') WHERE "created_by" <> (SELECT "id" FROM "users" WHERE "email" = 'local@quilt.local');--> statement-breakpoint
UPDATE "channels" SET "user_id" = (SELECT "id" FROM "users" WHERE "email" = 'local@quilt.local') WHERE "user_id" <> (SELECT "id" FROM "users" WHERE "email" = 'local@quilt.local');--> statement-breakpoint
UPDATE "usage_entries" SET "user_id" = (SELECT "id" FROM "users" WHERE "email" = 'local@quilt.local') WHERE "user_id" <> (SELECT "id" FROM "users" WHERE "email" = 'local@quilt.local');--> statement-breakpoint
DELETE FROM "users" WHERE "email" <> 'local@quilt.local';
