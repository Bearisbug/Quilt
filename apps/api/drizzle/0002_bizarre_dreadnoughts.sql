CREATE TABLE "annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"screen_id" uuid NOT NULL,
	"qid" text NOT NULL,
	"note" text NOT NULL,
	"anchor_text" text DEFAULT '' NOT NULL,
	"rect" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"sent_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_entries" ADD COLUMN "driver" text;--> statement-breakpoint
ALTER TABLE "usage_entries" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_screen_id_screens_id_fk" FOREIGN KEY ("screen_id") REFERENCES "public"."screens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "annotations_screen_status_idx" ON "annotations" USING btree ("screen_id","status");