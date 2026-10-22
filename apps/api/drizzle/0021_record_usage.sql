CREATE TABLE "model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"project_id" uuid,
	"seq" integer NOT NULL,
	"purpose" text NOT NULL,
	"runner" text,
	"driver" text,
	"model" text,
	"ok" boolean NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"image_keys" jsonb,
	"body_key" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"page" text,
	"type" text NOT NULL,
	"target" text,
	"project_id" uuid,
	"screen_id" uuid,
	"data" jsonb
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "record_usage" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "record_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "record_events" ADD CONSTRAINT "record_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_calls_job_seq_idx" ON "model_calls" USING btree ("job_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "record_events_session_seq_uq" ON "record_events" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "record_events_user_at_idx" ON "record_events" USING btree ("user_id","at");