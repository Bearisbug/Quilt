ALTER TABLE "screens" ADD COLUMN "ref_project_id" uuid;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "target_screen_id" uuid;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "target_qid" text;--> statement-breakpoint
ALTER TABLE "screens" ADD CONSTRAINT "screens_ref_project_id_projects_id_fk" FOREIGN KEY ("ref_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;