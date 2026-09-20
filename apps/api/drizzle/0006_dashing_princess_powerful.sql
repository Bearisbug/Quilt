DROP INDEX "generation_jobs_active_project_uq";--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "runner" text DEFAULT 'model' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "brief" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "exemplar_screen_id" uuid;--> statement-breakpoint
ALTER TABLE "screen_revisions" ADD COLUMN "parent_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "screen_revisions" ADD COLUMN "candidate_index" integer;--> statement-breakpoint
ALTER TABLE "screen_revisions" ADD COLUMN "candidate_settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "purpose" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "screen_revisions_job_idx" ON "screen_revisions" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_jobs_active_project_uq" ON "generation_jobs" USING btree ("project_id") WHERE status in ('queued','running') and kind = 'generate';