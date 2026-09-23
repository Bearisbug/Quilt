DROP INDEX "screens_project_route_uq";--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "variant_of" uuid;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "variant_name" text;--> statement-breakpoint
ALTER TABLE "screens" ADD COLUMN "presentation" text DEFAULT 'push' NOT NULL;--> statement-breakpoint
ALTER TABLE "screens" ADD CONSTRAINT "screens_variant_of_screens_id_fk" FOREIGN KEY ("variant_of") REFERENCES "public"."screens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "screens_variant_of_idx" ON "screens" USING btree ("variant_of");--> statement-breakpoint
CREATE UNIQUE INDEX "screens_project_route_uq" ON "screens" USING btree ("project_id","route") WHERE variant_of is null;