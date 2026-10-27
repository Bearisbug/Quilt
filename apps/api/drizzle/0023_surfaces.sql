CREATE TABLE "surfaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"device_type" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"states" jsonb DEFAULT '{"dims":[],"events":[]}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "screen_revisions" ADD COLUMN "states" jsonb;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "surface_id" uuid;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "group_name" text;--> statement-breakpoint
ALTER TABLE "surfaces" ADD CONSTRAINT "surfaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "surfaces_project_idx" ON "surfaces" USING btree ("project_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "surfaces_project_name_uq" ON "surfaces" USING btree ("project_id",lower("name"));--> statement-breakpoint
ALTER TABLE "screens" ADD CONSTRAINT "screens_surface_id_surfaces_id_fk" FOREIGN KEY ("surface_id") REFERENCES "public"."surfaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 回填（REQ-CORE-049，§25 端）：每个普通项目一端，手机叫 App、桌面叫 Web，设备取项目的；屏全部指过去。草稿本不建端，草稿的 surface_id 留空
INSERT INTO "surfaces" ("project_id", "name", "device_type", "position")
SELECT "id", CASE WHEN "device_type" = 'desktop' THEN 'Web' ELSE 'App' END, "device_type", 0 FROM "projects" WHERE "kind" = 'app';--> statement-breakpoint
UPDATE "screens" AS s SET "surface_id" = f."id" FROM "surfaces" AS f WHERE f."project_id" = s."project_id";--> statement-breakpoint
CREATE UNIQUE INDEX "screens_surface_route_uq" ON "screens" USING btree ("surface_id","route") WHERE variant_of is null and surface_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "screens_draft_route_uq" ON "screens" USING btree ("project_id","route") WHERE variant_of is null and surface_id is null;--> statement-breakpoint
CREATE INDEX "screens_surface_idx" ON "screens" USING btree ("surface_id");--> statement-breakpoint
DROP INDEX "screens_project_route_uq";
