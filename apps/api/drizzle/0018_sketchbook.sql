ALTER TABLE "projects" ADD COLUMN "kind" text DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "frame" text;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_sketchbook_uq" ON "projects" USING btree ("owner_id") WHERE kind = 'sketchbook';